//! The cached-area cleanup: areas unused for 48 hours are deleted by the hourly cron job.

use server::{AppState, MIGRATOR};

async fn insert(
    pool: &sqlx::SqlitePool,
    key: &str,
    created_hours_ago: i64,
    used_hours_ago: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO area_cache (key, info, data, created_at, used_at) VALUES (?1, '{}', x'00',
           strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', '-' || ?2 || ' hours'),
           CASE WHEN ?3 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', '-' || ?3 || ' hours') END)",
    )
    .bind(key)
    .bind(created_hours_ago)
    .bind(used_hours_ago)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn cleanup_deletes_areas_unused_for_48_hours() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let db = northstack::testing::db(&MIGRATOR).await;
    let pool = db.pool();
    insert(&pool, "new", 1, None).await;
    insert(&pool, "old-unused", 72, None).await;
    insert(&pool, "old-but-used", 72, Some(3)).await;
    insert(&pool, "used-long-ago", 100, Some(50)).await;

    let app = server::build();
    let state = AppState::new(pool.clone());
    assert!(
        app.cron_ref()
            .fire(&pool, "lm.cleanup", chrono::Utc::now())
            .await
            .unwrap()
    );
    assert_eq!(app.jobs_ref().run_pending(&pool, state).await.unwrap(), 1);

    let mut left: Vec<String> = sqlx::query_scalar("SELECT key FROM area_cache")
        .fetch_all(&pool)
        .await
        .unwrap();
    left.sort();
    assert_eq!(left, ["new", "old-but-used"]);
}
