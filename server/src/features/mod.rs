//! One module per feature. Each exposes `rpc()`, and optionally `jobs()`,
//! `cron()` and `routes()`, which are registered in `crate::build`.

pub mod lm;
