//! Background jobs: deleting cached areas nobody has looked at for a while.

use serde::{Deserialize, Serialize};

use super::db;
use crate::AppState;

/// Delete cached areas unused for [`db::KEEP_UNUSED_HOURS`]. Scheduled hourly by cron; safe to
/// run twice.
#[derive(Debug, Serialize, Deserialize)]
pub struct Cleanup {}

impl northstack::Job for Cleanup {
    const KIND: &'static str = "lm.cleanup";
    const MAX_ATTEMPTS: i32 = 3;
}

pub async fn cleanup(state: AppState, _job: Cleanup) -> anyhow::Result<()> {
    let deleted = db::delete_unused(&state.db, db::KEEP_UNUSED_HOURS).await?;
    if deleted > 0 {
        tracing::info!(deleted, "deleted unused areas");
    }
    Ok(())
}
