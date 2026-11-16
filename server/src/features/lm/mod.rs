//! Lantmäteriet (Sweden) data: 1 m terrain, trees and roof surfaces from airborne laser scanning.
//!
//! - `lm.status` and `lm.trees` are typed RPC procedures.
//! - `POST /api/lm/dtm` and `POST /api/lm/surface` return raw grids (binary, too big for JSON),
//!   with the grid geometry in the `X-Grid` header.
//!
//! Each area is downloaded and processed once, then served from the `area_cache` table; areas
//! unused for 48 hours are deleted by an hourly job (`jobs.rs`).

mod db;
mod dtm;
mod http;
mod jobs;
mod laser;
mod procedures;
mod routes;
mod sweref;
pub mod types;

pub use jobs::Cleanup;

use crate::AppState;
use northstack::{Cron, Jobs, Rpc};

pub fn rpc() -> Rpc<AppState> {
    Rpc::new()
        .query("lm.status", procedures::status)
        .query("lm.trees", procedures::trees)
}

pub fn routes() -> northstack::axum::Router<AppState> {
    routes::router()
}

pub fn jobs() -> Jobs<AppState> {
    Jobs::new().register(jobs::cleanup)
}

pub fn cron() -> Cron {
    // Every hour at minute 17.
    Cron::new().add("lm.cleanup", "0 17 * * * *", |_| Cleanup {})
}
