//! All SQL for the feature: the per-area cache of processed Lantmäteriet data.

use sqlx::{SqliteExecutor, SqlitePool};

/// Unused areas are deleted after this long (see `jobs::cleanup`).
pub const KEEP_UNUSED_HOURS: i64 = 48;

pub async fn exists(db: impl SqliteExecutor<'_>, key: &str) -> sqlx::Result<bool> {
    let found = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM area_cache WHERE key = $1) AS "found!: bool""#,
        key
    )
    .fetch_one(db)
    .await?;
    Ok(found)
}

/// One field of the cached info, without loading the grid bytes.
pub async fn info_field(
    db: &SqlitePool,
    key: &str,
    field: &str,
) -> sqlx::Result<Option<serde_json::Value>> {
    touch(db, key).await?;
    let v = sqlx::query_scalar!(
        r#"SELECT info -> ('$.' || $2) AS "v: serde_json::Value" FROM area_cache WHERE key = $1"#,
        key,
        field
    )
    .fetch_optional(db)
    .await?;
    Ok(v.flatten())
}

pub async fn get(db: &SqlitePool, key: &str) -> sqlx::Result<Option<(serde_json::Value, Vec<u8>)>> {
    touch(db, key).await?;
    let row = sqlx::query!("SELECT info, data FROM area_cache WHERE key = $1", key)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|r| (r.info, r.data)))
}

pub async fn put(
    db: impl SqliteExecutor<'_>,
    key: &str,
    info: &serde_json::Value,
    data: &[u8],
) -> sqlx::Result<()> {
    sqlx::query!(
        "INSERT INTO area_cache (key, info, data) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET info = excluded.info, data = excluded.data,
             created_at = strftime('%Y-%m-%dT%H:%M:%f+00:00')",
        key,
        info,
        data
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Record that an area was served. Written at most once an hour per area, so reads stay reads.
async fn touch(db: impl SqliteExecutor<'_>, key: &str) -> sqlx::Result<()> {
    sqlx::query!(
        "UPDATE area_cache SET used_at = strftime('%Y-%m-%dT%H:%M:%f+00:00')
         WHERE key = $1
           AND COALESCE(used_at, created_at) < strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', '-1 hour')",
        key
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Delete areas not served for `hours`. Returns how many were deleted.
pub async fn delete_unused(db: impl SqliteExecutor<'_>, hours: i64) -> sqlx::Result<u64> {
    let res = sqlx::query!(
        "DELETE FROM area_cache
         WHERE COALESCE(used_at, created_at)
             < strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', '-' || $1 || ' hours')",
        hours
    )
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}
