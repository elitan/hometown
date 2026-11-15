//! Lantmäteriet (Sweden) data: 1 m terrain, trees and roof surfaces from airborne laser scanning.
//!
//! - `lm.status` and `lm.trees` are typed RPC procedures.
//! - `POST /api/lm/dtm` and `POST /api/lm/surface` return raw grids (binary, too big for JSON),
//!   with the grid geometry in the `X-Grid` header.
//!
//! Each area is downloaded and processed once, then served from the `area_cache` table.

mod db;
mod dtm;
mod http;
mod laser;
mod procedures;
mod routes;
mod sweref;
pub mod types;

use crate::AppState;
use northstack::Rpc;

pub fn rpc() -> Rpc<AppState> {
    Rpc::new()
        .query("lm.status", procedures::status)
        .query("lm.trees", procedures::trees)
}

pub fn routes() -> northstack::axum::Router<AppState> {
    routes::router()
}
