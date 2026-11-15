//! All SQL for the feature: the per-area cache of processed Lantmäteriet data.

use sqlx::PgExecutor;

pub async fn exists(db: impl PgExecutor<'_>, key: &str) -> sqlx::Result<bool> {
    let found = sqlx::query_scalar!(
        "SELECT EXISTS (SELECT 1 FROM area_cache WHERE key = $1)",
        key
    )
    .fetch_one(db)
    .await?;
    Ok(found.unwrap_or(false))
}

/// One field of the cached info, without loading the grid bytes.
pub async fn info_field(
    db: impl PgExecutor<'_>,
    key: &str,
    field: &str,
) -> sqlx::Result<Option<serde_json::Value>> {
    let v = sqlx::query_scalar!(
        "SELECT info -> $2 FROM area_cache WHERE key = $1",
        key,
        field
    )
    .fetch_optional(db)
    .await?;
    Ok(v.flatten())
}

pub async fn get(
    db: impl PgExecutor<'_>,
    key: &str,
) -> sqlx::Result<Option<(serde_json::Value, Vec<u8>)>> {
    let row = sqlx::query!("SELECT info, data FROM area_cache WHERE key = $1", key)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|r| (r.info, r.data)))
}

pub async fn put(
    db: impl PgExecutor<'_>,
    key: &str,
    info: &serde_json::Value,
    data: &[u8],
) -> sqlx::Result<()> {
    sqlx::query!(
        "INSERT INTO area_cache (key, info, data) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET info = EXCLUDED.info, data = EXCLUDED.data, created_at = now()",
        key,
        info,
        data
    )
    .execute(db)
    .await?;
    Ok(())
}
