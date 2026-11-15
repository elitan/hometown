//! Lantmäteriet "Laserdata Skog" point clouds (COPC, LAS 1.4 point format 6, LAZ-compressed) ->
//! 1 m ground and canopy-top grids -> height above ground -> tree tops (local maxima).
//! Only the octree nodes inside the area are downloaded, and only X, Y, Z and the class are decoded.

use std::io::Cursor;

use anyhow::{Context, bail};
use futures::{StreamExt, TryStreamExt, stream};
use laz::record::{LayeredPointRecordDecompressor, RecordDecompressor};
use laz::{DecompressionSelection, LazVlr};

use super::http::{self, DOWNLOAD};
use super::sweref;
use super::types::{Grid, Tree, TreesResult};
use crate::AppState;

const CLASS_GROUND: u8 = 2;
/// unclassified + vegetation (Lantmäteriet puts vegetation in class 1)
const CANOPY: [u8; 5] = [0, 1, 3, 4, 5];
const RES: f64 = 1.0;
const DOWNLOADS: usize = 16;

#[derive(Clone, Copy)]
struct Area {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Area {
    fn overlaps(&self, b: &Area) -> bool {
        self.x0 < b.x1 && self.x1 > b.x0 && self.y0 < b.y1 && self.y1 > b.y0
    }
}

/// What we need from a COPC file's header and VLRs.
struct Copc {
    url: String,
    scale: [f64; 3],
    offset: [f64; 3],
    record_len: usize,
    laz: LazVlr,
    cube_min: (f64, f64),
    cube_size: f64,
    root_page: (u64, u64),
}

/// One octree node with points: where its compressed chunk is, and how many points it holds.
struct Node {
    offset: u64,
    size: u64,
    count: usize,
}

fn le_f64(b: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(b[at..at + 8].try_into().expect("8 bytes"))
}
fn le_u64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().expect("8 bytes"))
}
fn le_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().expect("4 bytes"))
}
fn le_u16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(b[at..at + 2].try_into().expect("2 bytes"))
}
fn le_i32(b: &[u8], at: usize) -> i32 {
    i32::from_le_bytes(b[at..at + 4].try_into().expect("4 bytes"))
}

async fn open(state: &AppState, url: &str) -> anyhow::Result<Copc> {
    let mut head = http::range(state, url, 0, 4096).await?;
    if head.len() < 375 || &head[0..4] != b"LASF" {
        bail!("not a LAS file");
    }
    let point_data = le_u32(&head, 96) as u64;
    if point_data > head.len() as u64 {
        head = http::range(state, url, 0, point_data).await?;
    }
    let header_size = le_u16(&head, 94) as usize;
    let n_vlrs = le_u32(&head, 100);
    let format = head[104] & 0x3f;
    if format != 6 && format != 7 && format != 8 {
        bail!("unexpected point format {format}");
    }
    let scale = [le_f64(&head, 131), le_f64(&head, 139), le_f64(&head, 147)];
    let offset = [le_f64(&head, 155), le_f64(&head, 163), le_f64(&head, 171)];
    let (mut info, mut laz) = (None, None);
    let mut at = header_size;
    for _ in 0..n_vlrs {
        if at + 54 > head.len() {
            break;
        }
        let user = String::from_utf8_lossy(&head[at + 2..at + 18])
            .trim_end_matches('\0')
            .to_string();
        let record = le_u16(&head, at + 18);
        let len = le_u16(&head, at + 20) as usize;
        let data = head.get(at + 54..at + 54 + len).context("truncated VLR")?;
        match (user.as_str(), record) {
            ("copc", 1) => info = Some(data.to_vec()),
            ("laszip encoded", 22204) => laz = Some(LazVlr::from_buffer(data)?),
            _ => {}
        }
        at += 54 + len;
    }
    let info = info.context("no COPC info VLR")?;
    let (cx, cy, half) = (le_f64(&info, 0), le_f64(&info, 8), le_f64(&info, 24));
    Ok(Copc {
        url: url.to_string(),
        scale,
        offset,
        record_len: le_u16(&head, 105) as usize,
        laz: laz.context("no LAZ VLR")?,
        cube_min: (cx - half, cy - half),
        cube_size: 2.0 * half,
        root_page: (le_u64(&info, 40), le_u64(&info, 48)),
    })
}

/// Walk the hierarchy pages, keeping nodes (and only descending into pages) that overlap the area.
async fn nodes_in_area(state: &AppState, copc: &Copc, area: Area) -> anyhow::Result<Vec<Node>> {
    let mut nodes = Vec::new();
    let mut pages = vec![copc.root_page];
    while !pages.is_empty() {
        let fetched = futures::future::try_join_all(
            pages
                .iter()
                .map(|&(off, size)| http::range(state, &copc.url, off, off + size)),
        )
        .await?;
        pages = Vec::new();
        for page in fetched {
            for e in page.as_chunks::<32>().0 {
                let (d, x, y) = (le_i32(e, 0), le_i32(e, 4) as f64, le_i32(e, 8) as f64);
                let size = copc.cube_size / 2f64.powi(d);
                let b = Area {
                    x0: copc.cube_min.0 + x * size,
                    y0: copc.cube_min.1 + y * size,
                    x1: copc.cube_min.0 + (x + 1.0) * size,
                    y1: copc.cube_min.1 + (y + 1.0) * size,
                };
                if !b.overlaps(&area) {
                    continue;
                }
                let (offset, bytes, count) = (le_u64(e, 16), le_i32(e, 24), le_i32(e, 28));
                if count == -1 {
                    pages.push((offset, bytes as u64));
                } else if count > 0 && bytes > 0 {
                    nodes.push(Node {
                        offset,
                        size: bytes as u64,
                        count: count as usize,
                    });
                }
            }
        }
    }
    Ok(nodes)
}

/// A point inside the area: grid cell, height, and whether it is ground.
type Pt = (u32, f32, bool);

/// Decompress one node (X, Y, Z and class only) and keep ground / canopy points inside the area.
fn decode_node(
    copc: &Copc,
    raw: Vec<u8>,
    count: usize,
    area: Area,
    w: usize,
) -> anyhow::Result<(Vec<Pt>, usize)> {
    let mut dec = LayeredPointRecordDecompressor::new(Cursor::new(raw));
    dec.set_fields_from(copc.laz.items())?;
    dec.set_selection(
        DecompressionSelection::xy_returns_channel()
            .decompress_z()
            .decompress_classification(),
    );
    let rec = dec.record_size();
    if rec != copc.record_len {
        bail!("record size {rec} != header {}", copc.record_len);
    }
    let mut buf = vec![0u8; rec * count];
    dec.decompress_many(&mut buf)?;
    let (mut pts, mut inside) = (Vec::with_capacity(count), 0);
    for p in buf.chunks_exact(rec) {
        let x = le_i32(p, 0) as f64 * copc.scale[0] + copc.offset[0];
        let y = le_i32(p, 4) as f64 * copc.scale[1] + copc.offset[1];
        if x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1 {
            continue;
        }
        inside += 1;
        let class = p[16];
        let ground = class == CLASS_GROUND;
        if !ground && !CANOPY.contains(&class) {
            continue;
        }
        let k = ((area.y1 - y) / RES) as usize * w + ((x - area.x0) / RES) as usize;
        let z = (le_i32(p, 8) as f64 * copc.scale[2] + copc.offset[2]) as f32;
        pts.push((k as u32, z, ground));
    }
    Ok((pts, inside))
}

/// Latest laser file for each 2.5 km square covering the bbox: (href, date).
async fn laser_files(state: &AppState, bbox: [f64; 4]) -> anyhow::Result<Vec<(String, String)>> {
    let mut latest: std::collections::HashMap<String, (String, String)> = Default::default();
    for f in http::stac_search(state, bbox, "dsm-skoglig-copc", 50).await? {
        let id = f["id"].as_str().unwrap_or_default();
        let square = id.split('-').skip(1).collect::<Vec<_>>().join("-");
        let date = f["properties"]["datetime"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let Some(href) = f["assets"]["data"]["href"].as_str() else {
            continue;
        };
        if !href.starts_with(DOWNLOAD) {
            continue;
        }
        if latest.get(&square).is_none_or(|(_, d)| *d < date) {
            latest.insert(square, (href.to_string(), date));
        }
    }
    Ok(latest.into_values().collect())
}

/// Trees and the height-above-ground grid (Uint16 centimetres, row 0 = north) for a bbox.
pub async fn process(
    state: &AppState,
    bbox: [f64; 4],
) -> anyhow::Result<(TreesResult, Grid, Vec<u16>)> {
    let t0 = std::time::Instant::now();
    let (x0, y0, x1, y1) = sweref::bbox_tm(bbox);
    let area = Area { x0, y0, x1, y1 };
    let w = ((x1 - x0) / RES).ceil() as usize;
    let h = ((y1 - y0) / RES).ceil() as usize;

    let files = laser_files(state, bbox).await?;
    if files.is_empty() {
        bail!("No laser data for this area");
    }
    // open every file and list its nodes in parallel, then stream all nodes through one download pool
    let opened = futures::future::try_join_all(files.iter().map(|(href, _)| async move {
        let copc = std::sync::Arc::new(open(state, href).await?);
        let nodes = nodes_in_area(state, &copc, area).await?;
        anyhow::Ok(
            nodes
                .into_iter()
                .map(move |n| (copc.clone(), n))
                .collect::<Vec<_>>(),
        )
    }))
    .await?;
    let jobs: Vec<_> = opened.into_iter().flatten().collect();

    let mut ground = vec![f32::INFINITY; w * h];
    let mut top = vec![f32::NEG_INFINITY; w * h];
    let mut points = 0usize;
    let mut decoded = stream::iter(jobs)
        .map(|(copc, node)| async move {
            let raw = http::range(state, &copc.url, node.offset, node.offset + node.size).await?;
            northstack::cpu::spawn(move || decode_node(&copc, raw, node.count, area, w)).await?
        })
        .buffer_unordered(DOWNLOADS);
    while let Some((pts, inside)) = decoded.try_next().await? {
        points += inside;
        for (k, z, is_ground) in pts {
            let k = k as usize;
            if is_ground {
                ground[k] = ground[k].min(z);
            } else {
                top[k] = top[k].max(z);
            }
        }
    }
    drop(decoded);

    let (trees, surface) = northstack::cpu::spawn(move || detect(ground, top, w, h, area)).await?;
    let year = files
        .iter()
        .map(|(_, d)| d.get(..4).unwrap_or("").to_string())
        .max()
        .unwrap_or_default();
    let ms = t0.elapsed().as_millis() as u32;
    tracing::info!(points, trees = trees.len(), ms, "laser processed");
    let grid = Grid {
        min_e: x0,
        max_n: y1,
        res: RES,
        w: w as u32,
        h: h as u32,
    };
    Ok((
        TreesResult {
            trees,
            points: points as u32,
            year,
            ms,
        },
        grid,
        surface,
    ))
}

/// Canopy height model -> smoothed -> local maxima with a height-dependent window = tree tops.
fn detect(
    mut ground: Vec<f32>,
    top: Vec<f32>,
    w: usize,
    h: usize,
    area: Area,
) -> (Vec<Tree>, Vec<u16>) {
    fill_ground(&mut ground, w, h);
    let chm: Vec<f32> = top
        .iter()
        .zip(&ground)
        .map(|(&t, &g)| {
            if t > f32::NEG_INFINITY && g < f32::INFINITY {
                (t - g).max(0.0)
            } else {
                0.0
            }
        })
        .collect();
    let sm = blur3(&chm, w, h);
    let mut trees = Vec::new();
    for y in 4..h.saturating_sub(4) {
        for x in 4..w.saturating_sub(4) {
            let k = y * w + x;
            let ht = sm[k];
            if !(3.0..=45.0).contains(&ht) {
                continue;
            }
            let r: isize = if ht < 8.0 {
                2
            } else if ht < 16.0 {
                3
            } else {
                4
            };
            let mut peak = true;
            'win: for dy in -r..=r {
                for dx in -r..=r {
                    if (dx == 0 && dy == 0) || dx * dx + dy * dy > r * r {
                        continue;
                    }
                    let off = dy * w as isize + dx;
                    let v = sm[(k as isize + off) as usize];
                    if v > ht || (v == ht && off < 0) {
                        peak = false;
                        break 'win;
                    }
                }
            }
            if !peak {
                continue;
            }
            let (lon, lat) = sweref::inverse(
                area.x0 + (x as f64 + 0.5) * RES,
                area.y1 - (y as f64 + 0.5) * RES,
            );
            let height = if chm[k] != 0.0 { chm[k] } else { ht };
            let crown = (0.8 + 0.11 * height).clamp(1.2, 5.5);
            let r1 = |v: f32| (v * 10.0).round() / 10.0;
            let r6 = |v: f64| (v * 1e6).round() / 1e6;
            trees.push((r6(lon), r6(lat), r1(height), r1(crown)));
        }
    }
    // the raw (unsmoothed) height above ground: roofs are measured from it
    let surface = chm
        .iter()
        .map(|&v| (v * 100.0).round().min(65535.0) as u16)
        .collect();
    (trees, surface)
}

fn blur3(a: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0f32; a.len()];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let k = y * w + x;
            out[k] = (4.0 * a[k]
                + 2.0 * (a[k - 1] + a[k + 1] + a[k - w] + a[k + w])
                + a[k - w - 1]
                + a[k - w + 1]
                + a[k + w - 1]
                + a[k + w + 1])
                / 16.0;
        }
    }
    out
}

/// Fill ground gaps (under dense canopy and buildings) from the nearest ground along rows, then columns.
fn fill_ground(g: &mut [f32], w: usize, h: usize) {
    for pass in 0..2 {
        let (outer, inner) = if pass == 0 { (h, w) } else { (w, h) };
        let idx = |o: usize, i: usize| if pass == 0 { o * w + i } else { i * w + o };
        for o in 0..outer {
            let mut last = f32::INFINITY;
            for i in 0..inner {
                let k = idx(o, i);
                if g[k] == f32::INFINITY {
                    if last < f32::INFINITY {
                        g[k] = last;
                    }
                } else {
                    last = g[k];
                }
            }
            last = f32::INFINITY;
            for i in (0..inner).rev() {
                let k = idx(o, i);
                if g[k] == f32::INFINITY {
                    if last < f32::INFINITY {
                        g[k] = last;
                    }
                } else {
                    last = g[k];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_one_tree_per_crown() {
        let (w, h) = (30, 30);
        let ground = vec![100.0; w * h];
        let mut top = vec![f32::NEG_INFINITY; w * h];
        // a 12 m cone-shaped crown centred on (15, 15)
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - 15.0).powi(2) + (y as f32 - 15.0).powi(2)).sqrt();
                if d < 4.0 {
                    top[y * w + x] = 112.0 - d;
                }
            }
        }
        let area = Area {
            x0: 400_000.0,
            y0: 6_200_000.0,
            x1: 400_030.0,
            y1: 6_200_030.0,
        };
        let (trees, surface) = detect(ground, top, w, h, area);
        assert_eq!(trees.len(), 1);
        assert_eq!(trees[0].2, 12.0);
        assert_eq!(surface[15 * w + 15], 1200);
    }
}
