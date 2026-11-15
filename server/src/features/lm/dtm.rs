//! Lantmäteriet's 1 m terrain model ("Markhöjdmodell", Cloud Optimized GeoTIFFs in 10 km tiles):
//! read a bbox into one Float32 grid. Only the 512 px tiles under the area are downloaded (range
//! requests), from the overview level that matches the requested resolution.

use anyhow::{Context, bail};
use futures::{StreamExt, TryStreamExt, stream};
use std::io::Read;

use super::http::{self, DOWNLOAD};
use super::sweref;
use super::types::Grid;
use crate::AppState;

/// One image (full resolution or an overview) in a tiled GeoTIFF.
#[derive(Debug, Default, Clone)]
struct Ifd {
    width: usize,
    height: usize,
    tile_w: usize,
    tile_h: usize,
    bits: u16,
    sample_format: u16,
    compression: u16,
    predictor: u16,
    offsets: Vec<u64>,
    counts: Vec<u64>,
    nodata: Option<f32>,
    scale: Option<f64>,
    tie: Option<(f64, f64)>,
}

/// Header bytes of a TIFF, fetching anything referenced beyond them.
struct Tiff<'a> {
    state: &'a AppState,
    url: &'a str,
    head: Vec<u8>,
    le: bool,
}

const HEAD: u64 = 64 * 1024;

impl Tiff<'_> {
    fn u16(&self, b: &[u8]) -> u16 {
        let a = [b[0], b[1]];
        if self.le {
            u16::from_le_bytes(a)
        } else {
            u16::from_be_bytes(a)
        }
    }
    fn u32(&self, b: &[u8]) -> u32 {
        let a = [b[0], b[1], b[2], b[3]];
        if self.le {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        }
    }
    fn f64(&self, b: &[u8]) -> f64 {
        let a: [u8; 8] = b[..8].try_into().expect("8 bytes");
        if self.le {
            f64::from_le_bytes(a)
        } else {
            f64::from_be_bytes(a)
        }
    }

    async fn bytes(&self, off: u64, len: u64) -> anyhow::Result<std::borrow::Cow<'_, [u8]>> {
        let end = off + len;
        if end <= self.head.len() as u64 {
            Ok(std::borrow::Cow::Borrowed(
                &self.head[off as usize..end as usize],
            ))
        } else {
            Ok(std::borrow::Cow::Owned(
                http::range(self.state, self.url, off, end).await?,
            ))
        }
    }

    /// All IFDs (the image and its overviews).
    async fn ifds(&self) -> anyhow::Result<Vec<Ifd>> {
        let mut out = Vec::new();
        let mut off = self.u32(&self.head[4..8]) as u64;
        while off != 0 && out.len() < 16 {
            let n = self.u16(self.bytes(off, 2).await?.as_ref()) as u64;
            let entries = self.bytes(off + 2, n * 12 + 4).await?.into_owned();
            let mut ifd = Ifd {
                compression: 1,
                predictor: 1,
                sample_format: 1,
                ..Default::default()
            };
            for e in entries[..(n * 12) as usize].as_chunks::<12>().0 {
                let (tag, typ, count) = (
                    self.u16(&e[0..2]),
                    self.u16(&e[2..4]),
                    self.u32(&e[4..8]) as u64,
                );
                let size = match typ {
                    1 | 2 | 6 | 7 => 1,
                    3 | 8 => 2,
                    4 | 9 | 11 => 4,
                    5 | 10 | 12 | 16 => 8,
                    _ => 1,
                };
                let total = size * count;
                let raw = if total <= 4 {
                    e[8..12].to_vec()
                } else {
                    self.bytes(self.u32(&e[8..12]) as u64, total)
                        .await?
                        .into_owned()
                };
                let ints = || -> Vec<u64> {
                    (0..count as usize)
                        .map(|i| match typ {
                            3 => self.u16(&raw[i * 2..]) as u64,
                            4 => self.u32(&raw[i * 4..]) as u64,
                            _ => 0,
                        })
                        .collect()
                };
                let one = || ints().first().copied().unwrap_or(0);
                match tag {
                    256 => ifd.width = one() as usize,
                    257 => ifd.height = one() as usize,
                    258 => ifd.bits = one() as u16,
                    259 => ifd.compression = one() as u16,
                    317 => ifd.predictor = one() as u16,
                    322 => ifd.tile_w = one() as usize,
                    323 => ifd.tile_h = one() as usize,
                    324 => ifd.offsets = ints(),
                    325 => ifd.counts = ints(),
                    339 => ifd.sample_format = one() as u16,
                    33550 => ifd.scale = Some(self.f64(&raw)),
                    33922 if raw.len() >= 48 => {
                        ifd.tie = Some((self.f64(&raw[24..]), self.f64(&raw[32..])))
                    }
                    42113 => {
                        let s = String::from_utf8_lossy(&raw);
                        ifd.nodata = s
                            .trim_matches(|c: char| c == '\0' || c.is_whitespace())
                            .parse()
                            .ok();
                    }
                    _ => {}
                }
            }
            out.push(ifd);
            off = self.u32(&entries[(n * 12) as usize..]) as u64;
        }
        Ok(out)
    }
}

/// Decompress one tile into Float32 samples.
fn decode_tile(raw: &[u8], ifd: &Ifd, le: bool) -> anyhow::Result<Vec<f32>> {
    let (tw, th) = (ifd.tile_w, ifd.tile_h);
    let mut buf = Vec::with_capacity(tw * th * 4);
    match ifd.compression {
        1 => buf.extend_from_slice(raw),
        8 | 32946 => {
            flate2::read::ZlibDecoder::new(raw)
                .read_to_end(&mut buf)
                .context("inflate tile")?;
        }
        c => bail!("unsupported TIFF compression {c}"),
    }
    if buf.len() < tw * th * 4 {
        bail!("short tile ({} bytes)", buf.len());
    }
    let mut out = vec![0f32; tw * th];
    match ifd.predictor {
        // floating point predictor: per row, bytes are differenced, then split into planes, most significant byte first
        3 => {
            for (row, dst) in buf
                .chunks_exact_mut(tw * 4)
                .zip(out.chunks_exact_mut(tw))
                .take(th)
            {
                for i in 1..row.len() {
                    row[i] = row[i].wrapping_add(row[i - 1]);
                }
                for (i, v) in dst.iter_mut().enumerate() {
                    *v =
                        f32::from_be_bytes([row[i], row[tw + i], row[2 * tw + i], row[3 * tw + i]]);
                }
            }
        }
        1 => {
            for (v, b) in out.iter_mut().zip(buf.as_chunks::<4>().0) {
                let a = [b[0], b[1], b[2], b[3]];
                *v = if le {
                    f32::from_le_bytes(a)
                } else {
                    f32::from_be_bytes(a)
                };
            }
        }
        p => bail!("unsupported TIFF predictor {p}"),
    }
    Ok(out)
}

/// The part of one terrain file that falls inside the area, resampled to `res` (nearest).
struct Patch {
    gx0: usize,
    gy0: usize,
    w: usize,
    h: usize,
    data: Vec<f32>,
}

async fn read_file(
    state: &AppState,
    url: &str,
    area: (f64, f64, f64, f64),
    res: f64,
) -> anyhow::Result<Option<Patch>> {
    let (min_e, min_n, max_e, max_n) = area;
    let head = http::range(state, url, 0, HEAD).await?;
    if head.len() < 8 {
        bail!("not a TIFF");
    }
    let le = &head[0..2] == b"II";
    let tiff = Tiff {
        state,
        url,
        head,
        le,
    };
    if tiff.u16(&tiff.head[2..4]) != 42 {
        bail!("BigTIFF is not supported");
    }
    let ifds = tiff.ifds().await?;
    let full = ifds.first().context("no image in TIFF")?;
    let pr0 = full.scale.context("no pixel scale")?;
    let (bx0, by1) = full.tie.context("no tie point")?;
    let (bx1, by0) = (
        bx0 + full.width as f64 * pr0,
        by1 - full.height as f64 * pr0,
    );

    // coarsest level that is still at least as sharp as asked for
    let level = ifds
        .iter()
        .filter(|i| i.bits == 32 && i.sample_format == 3 && i.tile_w > 0 && !i.offsets.is_empty())
        .filter(|i| (bx1 - bx0) / i.width as f64 <= res * 1.0001)
        .max_by(|a, b| (a.width as f64).total_cmp(&(b.width as f64)).reverse())
        .context("no usable image level")?
        .clone();
    let nodata = level.nodata.or(full.nodata);
    let pr = (bx1 - bx0) / level.width as f64;

    let (ix0, ix1, iy0, iy1) = (
        min_e.max(bx0),
        max_e.min(bx1),
        min_n.max(by0),
        max_n.min(by1),
    );
    if ix0 >= ix1 || iy0 >= iy1 {
        return Ok(None);
    }
    let w = (((ix1 - ix0) / res).round() as usize).max(1);
    let h = (((iy1 - iy0) / res).round() as usize).max(1);
    let gx0 = ((ix0 - min_e) / res).round() as usize;
    let gy0 = ((max_n - iy1) / res).round() as usize;
    // source pixel for every output column / row
    let px: Vec<usize> = (0..w)
        .map(|x| {
            ((((ix0 - bx0) + (x as f64 + 0.5) * (ix1 - ix0) / w as f64) / pr) as usize)
                .min(level.width - 1)
        })
        .collect();
    let py: Vec<usize> = (0..h)
        .map(|y| {
            ((((by1 - iy1) + (y as f64 + 0.5) * (iy1 - iy0) / h as f64) / pr) as usize)
                .min(level.height - 1)
        })
        .collect();
    let (tw, th) = (level.tile_w, level.tile_h);
    let across = level.width.div_ceil(tw);
    let (tx0, tx1) = (px[0] / tw, px[w - 1] / tw);
    let (ty0, ty1) = (py[0] / th, py[h - 1] / th);
    let tiles: Vec<(usize, usize)> = (ty0..=ty1)
        .flat_map(|ty| (tx0..=tx1).map(move |tx| (tx, ty)))
        .collect();

    let mut data = vec![f32::NAN; w * h];
    let level = std::sync::Arc::new(level);
    let mut decoded = stream::iter(tiles)
        .map(|(tx, ty)| {
            let level = level.clone();
            async move {
                let i = ty * across + tx;
                let (off, len) = (
                    level.offsets.get(i).copied().unwrap_or(0),
                    level.counts.get(i).copied().unwrap_or(0),
                );
                if len == 0 {
                    return Ok::<_, anyhow::Error>(None); // sparse tile: no data
                }
                let raw = http::range(state, url, off, off + len).await?;
                let tile = northstack::cpu::spawn(move || decode_tile(&raw, &level, le)).await??;
                Ok(Some((tx, ty, tile)))
            }
        })
        .buffer_unordered(8);
    while let Some(t) = decoded.try_next().await? {
        let Some((tx, ty, tile)) = t else { continue };
        for (y, &sy) in py.iter().enumerate().filter(|(_, sy)| **sy / th == ty) {
            for (x, &sx) in px.iter().enumerate().filter(|(_, sx)| **sx / tw == tx) {
                let v = tile[(sy - ty * th) * tw + (sx - tx * tw)];
                if v.is_finite() && v > -1000.0 && Some(v) != nodata {
                    data[y * w + x] = v;
                }
            }
        }
    }
    Ok(Some(Patch {
        gx0,
        gy0,
        w,
        h,
        data,
    }))
}

/// Terrain heights for a WGS84 bbox on a `res` metre SWEREF 99 TM grid, row 0 = north.
pub async fn read(state: &AppState, bbox: [f64; 4], res: f64) -> anyhow::Result<(Grid, Vec<f32>)> {
    let area = sweref::bbox_tm(bbox);
    let (min_e, min_n, max_e, max_n) = area;
    let hrefs: Vec<String> = http::stac_search(state, bbox, "dtm-cog", 20)
        .await?
        .iter()
        .filter_map(|f| f["assets"]["data"]["href"].as_str().map(str::to_string))
        .filter(|h| h.starts_with(DOWNLOAD))
        .collect();
    if hrefs.is_empty() {
        bail!("No Lantmäteriet elevation for this area");
    }
    let w = ((max_e - min_e) / res).ceil() as usize;
    let h = ((max_n - min_n) / res).ceil() as usize;
    let mut data = vec![f32::NAN; w * h];

    let patches = futures::future::try_join_all(hrefs.iter().map(|href| async move {
        let mut last = None;
        for attempt in 0..3u64 {
            match read_file(state, href, area, res).await {
                Ok(p) => return Ok(p),
                Err(e) => {
                    tracing::warn!(error = %e, href, "terrain tile failed, retrying");
                    last = Some(e);
                    tokio::time::sleep(std::time::Duration::from_millis(400 << attempt)).await;
                }
            }
        }
        Err(last.expect("an error"))
    }))
    .await?;
    for p in patches.into_iter().flatten() {
        for y in 0..p.h {
            let gy = p.gy0 + y;
            if gy >= h {
                break;
            }
            for x in 0..p.w {
                let gx = p.gx0 + x;
                if gx < w && !p.data[y * p.w + x].is_nan() {
                    data[gy * w + gx] = p.data[y * p.w + x];
                }
            }
        }
    }

    let valid = data.iter().filter(|v| !v.is_nan()).count();
    if valid < data.len() * 8 / 100 {
        bail!("Lantmäteriet elevation missing here");
    }
    // short gaps (tile seams, odd nodata) are filled from neighbours; long ones are open sea -> 0 m
    fill_gaps(&mut data, w, h);
    for v in &mut data {
        if v.is_nan() {
            *v = 0.0;
        }
    }
    Ok((
        Grid {
            min_e,
            max_n,
            res,
            w: w as u32,
            h: h as u32,
        },
        data,
    ))
}

const MAX_GAP: usize = 30;

/// Fill runs of no-data up to MAX_GAP cells along rows, then columns, from their edges.
fn fill_gaps(d: &mut [f32], w: usize, h: usize) {
    for pass in 0..2 {
        let (outer, inner) = if pass == 0 { (h, w) } else { (w, h) };
        let idx = |o: usize, i: usize| if pass == 0 { o * w + i } else { i * w + o };
        for o in 0..outer {
            let mut i = 0;
            while i < inner {
                if !d[idx(o, i)].is_nan() {
                    i += 1;
                    continue;
                }
                let mut j = i;
                while j < inner && d[idx(o, j)].is_nan() {
                    j += 1;
                }
                if j - i <= MAX_GAP {
                    let left = if i > 0 { d[idx(o, i - 1)] } else { f32::NAN };
                    let right = if j < inner { d[idx(o, j)] } else { f32::NAN };
                    let v = if left.is_nan() {
                        right
                    } else if right.is_nan() {
                        left
                    } else {
                        (left + right) / 2.0
                    };
                    if !v.is_nan() {
                        for k in i..j {
                            d[idx(o, k)] = v;
                        }
                    }
                }
                i = j;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floating_point_predictor_round_trips() {
        // encode two rows of 3 floats the way GDAL does, then decode
        let vals = [1.5f32, -2.25, 100.125, 0.0, 7.75, 3.0e-3];
        let tw = 3;
        let mut raw = Vec::new();
        for row in vals.chunks(tw) {
            let mut planes = vec![0u8; tw * 4];
            for (i, v) in row.iter().enumerate() {
                for (b, byte) in v.to_be_bytes().iter().enumerate() {
                    planes[b * tw + i] = *byte;
                }
            }
            for i in (1..planes.len()).rev() {
                planes[i] = planes[i].wrapping_sub(planes[i - 1]);
            }
            raw.extend(planes);
        }
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut z, &raw).unwrap();
        let ifd = Ifd {
            tile_w: tw,
            tile_h: 2,
            compression: 8,
            predictor: 3,
            ..Default::default()
        };
        assert_eq!(decode_tile(&z.finish().unwrap(), &ifd, true).unwrap(), vals);
    }

    #[test]
    fn fills_short_gaps_only() {
        let n = f32::NAN;
        let mut row = vec![1.0, n, n, 3.0];
        fill_gaps(&mut row, 4, 1);
        assert_eq!(row, vec![1.0, 2.0, 2.0, 3.0]);
        let mut sea = vec![5.0; 1];
        sea.extend(std::iter::repeat_n(n, MAX_GAP + 1));
        let len = sea.len();
        fill_gaps(&mut sea, len, 1);
        assert!(
            sea[1].is_nan() && sea[len - 1].is_nan(),
            "long runs (sea) stay empty"
        );
    }
}
