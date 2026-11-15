#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // rustls for Lantmäteriet downloads uses the same `ring` crypto as the database driver
    let _ = rustls::crypto::ring::default_provider().install_default();
    server::build()
        .run(|pool, _config| async move { Ok(server::AppState::new(pool)) })
        .await
}
