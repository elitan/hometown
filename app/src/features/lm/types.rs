//! Inputs and outputs shared with TypeScript, plus the grid geometry sent in the `X-Grid` header.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Whether Lantmäteriet downloads are configured on this server (nothing else is revealed).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LmStatus {
    pub lantmateriet: bool,
}

/// An area as WGS84 degrees: west, south, east, north.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AreaInput {
    pub bbox: [f64; 4],
    /// Grid resolution in metres (terrain only, 1–5; default 1).
    #[ts(optional)]
    pub res: Option<f64>,
}

/// A tree: longitude, latitude, height (m), crown radius (m).
pub type Tree = (f64, f64, f32, f32);

/// Trees detected from the laser data.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TreesResult {
    #[ts(type = "Array<[number, number, number, number]>")]
    pub trees: Vec<Tree>,
    /// Laser points inside the area.
    pub points: u32,
    /// Year of the newest laser scan used.
    pub year: String,
    /// How long processing took the first time, in milliseconds.
    pub ms: u32,
}

/// A SWEREF 99 TM grid: row 0 is the north edge (`maxN`), column 0 the west edge (`minE`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Grid {
    #[serde(rename = "minE")]
    pub min_e: f64,
    #[serde(rename = "maxN")]
    pub max_n: f64,
    pub res: f64,
    #[serde(rename = "W")]
    pub w: u32,
    #[serde(rename = "H")]
    pub h: u32,
}
