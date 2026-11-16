#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // rustls (Lantmäteriet downloads) is built without a crypto provider; use `ring`
    let _ = rustls::crypto::ring::default_provider().install_default();
    server::build()
        .run(|pool, _config| async move { Ok(server::AppState::new(pool)) })
        .await
}
