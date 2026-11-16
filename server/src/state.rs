use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;

/// Shared application state, available to every procedure (`ctx.state`) and
/// job handler. Keep it cheap to clone.
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    /// HTTP client for Lantmäteriet (connection pooling, rustls).
    pub http: reqwest::Client,
    /// `Basic ...` header from LM_USER / LM_PASS, if configured.
    pub lm_auth: Option<Arc<str>>,
    /// One lock per area being processed, so concurrent requests for the same
    /// area share one run instead of downloading it twice.
    pub area_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        let lm_auth = match (std::env::var("LM_USER"), std::env::var("LM_PASS")) {
            (Ok(u), Ok(p)) if !u.is_empty() && !p.is_empty() => {
                Some(Arc::from(format!("Basic {}", base64(&format!("{u}:{p}")))))
            }
            _ => None,
        };
        let http = reqwest::Client::builder()
            .user_agent("hometown-map")
            .pool_max_idle_per_host(32)
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("http client");
        Self {
            db,
            http,
            lm_auth,
            area_locks: Arc::default(),
        }
    }

    /// The lock for one area key (created on first use).
    pub fn area_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.area_locks.lock().expect("area lock map");
        // forget locks nobody holds any more
        map.retain(|_, l| Arc::strong_count(l) > 1);
        map.entry(key.to_string()).or_default().clone()
    }
}

fn base64(s: &str) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b = s.as_bytes();
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(super::base64("f"), "Zg==");
        assert_eq!(super::base64("fo"), "Zm8=");
        assert_eq!(super::base64("foo"), "Zm9v");
        assert_eq!(
            super::base64("user@example.com:pa ss"),
            "dXNlckBleGFtcGxlLmNvbTpwYSBzcw=="
        );
    }
}
