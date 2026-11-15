//! Downloads from Lantmäteriet. Their download server resets connections or answers 429/5xx under
//! many parallel range requests, so every request (including reading its body) is retried.

use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::Value;

use crate::AppState;

pub const STAC: &str = "https://api.lantmateriet.se/stac-hojd/v1";
pub const DOWNLOAD: &str = "https://dl1.lantmateriet.se/";

/// Bytes `[start, end)` of a protected file, with retries.
pub async fn range(state: &AppState, url: &str, start: u64, end: u64) -> anyhow::Result<Vec<u8>> {
    let auth = state.lm_auth.as_deref().context("no Lantmäteriet login")?;
    let mut last = None;
    for attempt in 0..5u32 {
        let res = state
            .http
            .get(url)
            .header("Authorization", auth)
            .header("Range", format!("bytes={}-{}", start, end - 1))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => return Ok(b.to_vec()),
                Err(e) => last = Some(anyhow::Error::from(e)),
            },
            Ok(r) if r.status().as_u16() == 429 || r.status().is_server_error() => {
                last = Some(anyhow::anyhow!("HTTP {}", r.status()))
            }
            Ok(r) => bail!("HTTP {} for {url}", r.status()),
            Err(e) => last = Some(e.into()),
        }
        backoff(attempt).await;
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("download failed")))
}

/// STAC search for a collection over a WGS84 bbox; returns the features.
pub async fn stac_search(
    state: &AppState,
    bbox: [f64; 4],
    collection: &str,
    limit: u32,
) -> anyhow::Result<Vec<Value>> {
    let body = serde_json::json!({ "bbox": bbox, "collections": [collection], "limit": limit });
    let mut last = None;
    for attempt in 0..4u32 {
        match state
            .http
            .post(format!("{STAC}/search"))
            .json(&body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                let j: Value = r.json().await?;
                return Ok(j["features"].as_array().cloned().unwrap_or_default());
            }
            Ok(r) => last = Some(anyhow::anyhow!("STAC search: HTTP {}", r.status())),
            Err(e) => last = Some(e.into()),
        }
        backoff(attempt).await;
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("STAC search failed")))
}

async fn backoff(attempt: u32) {
    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis())
        .unwrap_or(0)
        % 200) as u64;
    tokio::time::sleep(Duration::from_millis(300 * 2u64.pow(attempt) + jitter)).await;
}
