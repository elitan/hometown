//! All SQL for the feature: the per-area cache of processed Lantmäteriet data.

use sqlx::SqliteExecutor;

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
    db: impl SqliteExecutor<'_>,
    key: &str,
    field: &str,
) -> sqlx::Result<Option<serde_json::Value>> {
    let v = sqlx::query_scalar!(
        r#"SELECT info -> ('$.' || $2) AS "v: serde_json::Value" FROM area_cache WHERE key = $1"#,
        key,
        field
    )
    .fetch_optional(db)
    .await?;
    Ok(v.flatten())
}

pub async fn get(
    db: impl SqliteExecutor<'_>,
    key: &str,
) -> sqlx::Result<Option<(serde_json::Value, Vec<u8>)>> {
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
