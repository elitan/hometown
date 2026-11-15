# AGENTS.md

## This app: Hometown

A 3D map of any place, built in the browser from open data (`web/app/lib/map/`, three.js, no
framework code). The Rust server only does what the browser can't: Lantmäteriet (Sweden) downloads
that need a login, and the heavy processing of their data, cached per area in `area_cache`:

- `lm.status`, `lm.trees` (RPC) and `POST /api/lm/dtm`, `POST /api/lm/surface` (raw binary grids,
  geometry in the `X-Grid` header) in `server/src/features/lm/`.
- `LM_USER` / `LM_PASS` in `.env` hold a private Geotorget login. Never print, log or commit them.
- Look at changes in the browser: `just dev`, then http://localhost:5173 (`window.hometown` is the
  engine in development).

It is built on [northstack](https://github.com/elitan/northstack): Rust (axum + sqlx/Postgres) on
the server, React + TypeScript in the browser with Next.js-style folder routing (`web/app/`), typed
RPC in between, shipped as one binary. The framework's full guide is the northstack README, from
"The guide" onwards. This file repeats the parts you must never miss.

## The loop

```sh
just dev       # once per session: Postgres, api, Vite, in the background
just check     # after every change: regenerate, compile, typecheck, reload the api
just verify    # before you're done: check + fmt + clippy + tests + build
```

- `just check` returns only when the api is running your new code.
- Read failures literally. Each one ends with a "how to fix" line.
- `just logs` shows runtime warnings and errors since the api last started.
- A change is done when `just verify` passes and generated files are committed.

Types flow one way, and every step is generated:

```
migration.sql -> Postgres -> server/src/db/schema.rs -> Rust -> web/northstack/ -> React
```

## Never

- Edit generated files: `server/src/db/schema.rs`, `web/northstack/`, `.sqlx/`.
- Edit a migration that has been applied. Add a new one (`just migration <name>`).
- Write SQL outside a feature's `db.rs`, or build SQL with `format!`.
- Hand-write a table's row type. Use the generated struct from `crate::db`.
- Call `fetch` in React for RPC or add another router. Use `api`/`call` from `"northstack"`.
  (The map's binary grids, `/api/lm/*`, and the public open-data sources are plain `fetch`.)
- Hold a transaction open across slow I/O, or keep state in memory that must survive restarts.
- Add dependencies when the standard library or an existing dependency covers it.

## Layout

```
crates/northstack/      framework (rarely changed; add a test for every behavior change)
server/
  migrations/           SQL migrations (timestamped, append-only)
  src/db/schema.rs      GENERATED from Postgres
  src/lib.rs            build(): registers every feature
  src/state.rs          AppState (db pool, HTTP client, Lantmäteriet login, per-area locks)
  src/features/lm/      the one backend feature: types.rs, db.rs, procedures.rs, routes.rs, ...
web/
  app/                  pages: folders are URLs (page.tsx, layout.tsx, not-found.tsx, error.tsx)
  app/components/       React UI around the map
  app/lib/map/          the 3D engine and data sources
  northstack/           GENERATED client (`api`, `call`) and router. Never edit.
```

## Backend

- **Procedures:** input/output structs in `types.rs` with
  `#[derive(Debug, Clone, Serialize, Deserialize, TS)]` and `#[serde(rename_all = "camelCase")]`;
  handler `pub async fn name(ctx: Ctx<AppState>, input: In) -> RpcResult<Out>` in
  `procedures.rs`; register in the feature's `rpc()` with `.query(...)` or `.mutation(...)`.
- **Errors:** `northstack::ensure!(cond, "message")`, `RpcError::not_found(..)`. `?` on sqlx errors
  maps `RowNotFound` to NOT_FOUND, unique violations to CONFLICT, else INTERNAL (logged, not leaked).
- **Other HTTP routes** (binary responses): an axum `Router<AppState>` in the feature, added with
  `.routes(...)` in `server/src/lib.rs`.
- **CPU-heavy work** goes through `northstack::cpu::spawn(move || ...).await?`.
- **Database:** `COMMENT ON` becomes docs in Rust and TS; `@private` in a column comment keeps it
  out of JSON and TypeScript (`area_cache.data` uses it). Optional filters:
  `($1::text IS NULL OR col = $1)`.
- **Tests:** unit tests next to pure logic; integration tests in `server/tests/<feature>.rs`.

## Frontend

- A page is a default export in `web/app/<path>/page.tsx` that gets `{ params, searchParams }`.
- Data: `api.ns.proc.useQuery(input)` (suspends, never undefined), `useMutation()`, or
  `call("ns.proc", input)` outside React. Navigation: plain `<a href>`, or `navigate(...)`.
- The map keeps its place in the URL hash (`#Mala, Hässleholm`) and handles it itself.
