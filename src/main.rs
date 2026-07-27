mod api;
mod backup;
mod collections;
mod db;
mod engine;
mod fields;
mod legacy;
mod ics;
mod media;
mod notify;
mod tmdb;

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use tracing_subscriber::EnvFilter;

pub type Db = Arc<Mutex<rusqlite::Connection>>;

#[derive(Clone)]
pub struct App {
    pub db: Db,
    pub data_dir: PathBuf,
    pub modules: Vec<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let data_dir = PathBuf::from(std::env::var("KALENDS_DATA").unwrap_or_else(|_| "data".into()));
    let conn = db::open(&data_dir)?;
    db::seed_defaults(&conn)?;
    tracing::info!("database ready at {}", data_dir.join("kalends.db").display());

    // 模块开关：KALENDS_MODULES=renewals,media（默认全开）——只装其一时另一模块的接口与界面整体消失
    let modules: Vec<String> = std::env::var("KALENDS_MODULES")
        .unwrap_or_else(|_| "renewals,media".into())
        .split(',')
        .map(|m| m.trim().to_string())
        .filter(|m| m == "renewals" || m == "media")
        .collect();
    let app = App {
        db: Arc::new(Mutex::new(conn)),
        data_dir: data_dir.clone(),
        modules: modules.clone(),
    };
    if modules.iter().any(|m| m == "renewals") {
        tokio::spawn(notify::scheduler(app.db.clone()));
    }
    tokio::spawn(backup::scheduler(app.db.clone(), data_dir));

    let mut router = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/config.js", get(config_js))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.svg", get(icon))
        .merge(api::core_router())
        .merge(fields::router());
    if modules.iter().any(|m| m == "renewals") {
        router = router.merge(api::renewals_router());
    }
    if modules.iter().any(|m| m == "media") {
        router = router.merge(media::router());
    }
    let router = router
        .with_state(app.clone())
        .layer(middleware::from_fn_with_state(app, pin_gate));

    let addr: SocketAddr = std::env::var("KALENDS_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:4180".into())
        .parse()?;
    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// 设置 auth.pin 后，/api/* 需要 X-Kalends-Pin 头或 kalends_pin cookie；
/// 静态页与 /calendar.ics（自带令牌）不拦。
async fn pin_gate(State(app): State<App>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if !path.starts_with("/api") && !path.starts_with("/covers") && !path.starts_with("/logos") {
        return next.run(req).await;
    }
    let required = {
        let conn = app.db.lock().unwrap();
        db::get_setting(&conn, "auth.pin").unwrap_or_default()
    };
    if required.is_empty() {
        return next.run(req).await;
    }
    let header_ok = req
        .headers()
        .get("x-kalends-pin")
        .and_then(|v| v.to_str().ok())
        == Some(required.as_str());
    let cookie_ok = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map_or(false, |c| {
            c.split(';')
                .any(|kv| kv.trim() == format!("kalends_pin={required}"))
        });
    if header_ok || cookie_ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": "需要 PIN" }))).into_response()
    }
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../assets/index.html"))
}

async fn app_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        include_str!("../assets/app.js"),
    )
}

async fn style_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../assets/style.css"),
    )
}

async fn config_js(State(app): State<App>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        format!(
            "window.KALENDS_MODULES={};",
            serde_json::to_string(&app.modules).unwrap_or_else(|_| "[]".into())
        ),
    )
}

async fn manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json; charset=utf-8")],
        include_str!("../assets/manifest.webmanifest"),
    )
}

async fn icon() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/svg+xml")],
        include_str!("../assets/icon.svg"),
    )
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
