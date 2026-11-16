//! RPC handlers, and the cached processing shared with the binary routes.

use anyhow::Context;
use northstack::{Ctx, RpcError, RpcResult};

use super::types::*;
use super::{db, dtm, laser};
use crate::AppState;

pub async fn status(ctx: Ctx<AppState>, _input: ()) -> RpcResult<LmStatus> {
    Ok(LmStatus {
        lantmateriet: ctx.state.lm_auth.is_some(),
    })
}

pub async fn trees(ctx: Ctx<AppState>, input: AreaInput) -> RpcResult<TreesResult> {
    let bbox = check_area(&ctx.state, &input).map_err(|(code, msg)| RpcError::new(code, msg))?;
    if let Some((trees, _, _)) = ensure_laser(&ctx.state, bbox).await.map_err(failed)? {
        return Ok(trees);
    }
    let info = db::info_field(&ctx.state.db, &laser_key(bbox), "trees")
        .await?
        .ok_or_else(|| RpcError::not_found("laser data not cached"))?;
    serde_json::from_value(info).map_err(RpcError::internal)
}

fn failed(e: anyhow::Error) -> RpcError {
    tracing::error!(error = %e, "laser processing failed");
    RpcError::new(northstack::ErrorCode::Internal, e.to_string())
}

/// Validate an area: a small bbox (about 5 x 5 km at most), and a Lantmäteriet login on the server.
pub fn check_area(
    state: &AppState,
    input: &AreaInput,
) -> Result<[f64; 4], (northstack::ErrorCode, String)> {
    use northstack::ErrorCode::*;
    let [w, s, e, n] = input.bbox;
    if !input.bbox.iter().all(|v| v.is_finite()) || e <= w || n <= s {
        return Err((BadRequest, "bbox [w,s,e,n] required".into()));
    }
    // 4 × 4 km up to the far north of Sweden (69° N)
    if e - w > 0.11 || n - s > 0.05 {
        return Err((BadRequest, "Area too large".into()));
    }
    if let Some(res) = input.res
        && !(1.0..=5.0).contains(&res)
    {
        return Err((BadRequest, "res must be 1-5 m".into()));
    }
    if state.lm_auth.is_none() {
        return Err((Unauthorized, "Add LM_USER and LM_PASS to .env".into()));
    }
    Ok(input.bbox)
}

fn area_key(bbox: [f64; 4]) -> String {
    bbox.iter()
        .map(|v| format!("{v:.4}"))
        .collect::<Vec<_>>()
        .join("_")
}
pub fn laser_key(bbox: [f64; 4]) -> String {
    format!("laser:{}", area_key(bbox))
}
fn dtm_key(bbox: [f64; 4], res: f64) -> String {
    format!("dtm:{}_r{res}", area_key(bbox))
}

/// Process the laser data for an area unless it is cached. Returns the result if it was computed now
/// (concurrent requests for the same area wait for one run, then read the cache).
pub async fn ensure_laser(
    state: &AppState,
    bbox: [f64; 4],
) -> anyhow::Result<Option<(TreesResult, Grid, Vec<u8>)>> {
    let key = laser_key(bbox);
    if db::exists(&state.db, &key).await? {
        return Ok(None);
    }
    let lock = state.area_lock(&key);
    let _guard = lock.lock().await;
    if db::exists(&state.db, &key).await? {
        return Ok(None);
    }
    let (trees, grid, surface) = laser::process(state, bbox).await?;
    let bytes: Vec<u8> = surface.iter().flat_map(|v| v.to_le_bytes()).collect();
    let info = serde_json::json!({ "grid": grid, "trees": trees });
    db::put(&state.db, &key, &info, &bytes).await?;
    Ok(Some((trees, grid, bytes)))
}

/// Height above ground (Uint16 cm) for an area, from the cache or processed now.
pub async fn surface(state: &AppState, bbox: [f64; 4]) -> anyhow::Result<(Grid, Vec<u8>)> {
    if let Some((_, grid, bytes)) = ensure_laser(state, bbox).await? {
        return Ok((grid, bytes));
    }
    let (info, bytes) = db::get(&state.db, &laser_key(bbox))
        .await?
        .context("laser data not cached")?;
    Ok((serde_json::from_value(info["grid"].clone())?, bytes))
}

/// 1 m (or coarser) terrain (Float32 m) for an area, from the cache or read now. `bool` = cache hit.
pub async fn terrain(
    state: &AppState,
    bbox: [f64; 4],
    res: f64,
) -> anyhow::Result<(Grid, Vec<u8>, bool)> {
    let key = dtm_key(bbox, res);
    if let Some((info, bytes)) = db::get(&state.db, &key).await? {
        return Ok((serde_json::from_value(info)?, bytes, true));
    }
    let lock = state.area_lock(&key);
    let _guard = lock.lock().await;
    if let Some((info, bytes)) = db::get(&state.db, &key).await? {
        return Ok((serde_json::from_value(info)?, bytes, true));
    }
    let (grid, data) = dtm::read(state, bbox, res).await?;
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    db::put(&state.db, &key, &serde_json::to_value(grid)?, &bytes).await?;
    Ok((grid, bytes, false))
}
