//! Binary endpoints: raw little-endian grids with their geometry in the `X-Grid` header.

use northstack::axum::extract::State;
use northstack::axum::http::{HeaderValue, StatusCode, header};
use northstack::axum::response::{IntoResponse, Response};
use northstack::axum::routing::post;
use northstack::axum::{Json, Router};
use tower_http::CompressionLevel;
use tower_http::compression::CompressionLayer;

use super::procedures::{check_area, surface, terrain};
use super::types::{AreaInput, Grid};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/lm/dtm", post(dtm))
        .route("/api/lm/surface", post(surface_grid))
        // Fastest gzip: the framework's default level costs seconds on these multi-megabyte grids
        // for little gain. Its own compression skips responses that are already encoded.
        .layer(CompressionLayer::new().quality(CompressionLevel::Fastest))
}

/// 1 m terrain as Float32 metres, row 0 = north.
async fn dtm(State(state): State<AppState>, Json(input): Json<AreaInput>) -> Response {
    let bbox = match check_area(&state, &input) {
        Ok(b) => b,
        Err((code, msg)) => return error(code.status(), &msg),
    };
    match terrain(&state, bbox, input.res.unwrap_or(1.0)).await {
        Ok((grid, bytes, hit)) => grid_response(grid, bytes, hit),
        Err(e) => {
            tracing::error!(error = %e, "terrain failed");
            error(StatusCode::BAD_GATEWAY, &e.to_string())
        }
    }
}

/// Height above ground from the laser data as Uint16 centimetres, row 0 = north.
async fn surface_grid(State(state): State<AppState>, Json(input): Json<AreaInput>) -> Response {
    let bbox = match check_area(&state, &input) {
        Ok(b) => b,
        Err((code, msg)) => return error(code.status(), &msg),
    };
    match surface(&state, bbox).await {
        Ok((grid, bytes)) => grid_response(grid, bytes, false),
        Err(e) => {
            tracing::error!(error = %e, "surface failed");
            error(StatusCode::BAD_GATEWAY, &e.to_string())
        }
    }
}

fn grid_response(grid: Grid, bytes: Vec<u8>, hit: bool) -> Response {
    let info = serde_json::to_string(&grid).unwrap_or_default();
    let mut r = bytes.into_response();
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(v) = HeaderValue::from_str(&info) {
        h.insert("x-grid", v);
    }
    h.insert(
        "x-cache",
        HeaderValue::from_static(if hit { "hit" } else { "miss" }),
    );
    r
}

fn error(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}
