#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // rustls for Lantmäteriet downloads uses the same `ring` crypto as the database driver
    let _ = rustls::crypto::ring::default_provider().install_default();
    app::build()
        .run(|pool, _config| async move { Ok(app::AppState::new(pool)) })
        .await
}
