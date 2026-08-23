mod api;
mod backup;
mod collections;
mod db;
mod engine;
mod fields;
mod fx;
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
    extract::{Path, Request, State},
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

/// `kalends --health`：容器 HEALTHCHECK 自检（镜像里没有 curl / wget，为一件事装包
/// 不值当）。判据是"答得上话"（5xx 以下）而不是 200——设了 PIN 会被挡成 401，
/// 那恰恰说明服务活着。
async fn health_probe() -> ! {
    let addr = std::env::var("KALENDS_ADDR").unwrap_or_else(|_| "127.0.0.1:4180".into());
    // 0.0.0.0 是监听地址不是可连地址（容器里恒是它）
    let target = addr.replace("0.0.0.0:", "127.0.0.1:").replace("[::]:", "[::1]:");
    let alive = match reqwest::get(format!("http://{target}/api/health")).await {
        Ok(r) => r.status().as_u16() < 500,
        Err(e) => {
            eprintln!("health: {e}");
            false
        }
    };
    std::process::exit(if alive { 0 } else { 1 });
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--health") {
        health_probe().await;
    }
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let data_dir = PathBuf::from(std::env::var("KALENDS_DATA").unwrap_or_else(|_| "data".into()));
    let conn = db::open(&data_dir)?;
    db::seed_defaults(&conn)?;
    tracing::info!("database ready at {}", data_dir.join("kalends.db").display());
    // 到期日、剩余天数、摘要时刻、备份边界全看本地时区，而容器默认 UTC——「今天」会
    // 错位。启动时把本地时间与偏移打出来，好让这件事一眼看得见（compose 里设 TZ）。
    {
        let now = chrono::Local::now();
        tracing::info!("local time {} (UTC{})", now.format("%Y-%m-%d %H:%M"), now.format("%:z"));
    }

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
        .route("/js/{name}", get(js_file))
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
        // 读不出设置 ≠ 没设 PIN：把数据库故障折成空串，门会在最不该开的时候敞开
        match db::get_setting_checked(&conn, "auth.pin") {
            Ok(v) => v.unwrap_or_default(),
            Err(e) => {
                tracing::error!("pin gate cannot read settings: {e}");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "设置读不出来，先检查数据库" })),
                )
                    .into_response();
            }
        }
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
        .is_some_and(|c| {
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

/// 前端拆成八份（见 index.html 的加载顺序），仍是编译期嵌入的静态文本。
/// 用一个带名字的路由而不是八个 handler：加一份只要在这张表里补一行。
async fn js_file(Path(name): Path<String>) -> Response {
    let body = match name.as_str() {
        "core.js" => include_str!("../assets/js/core.js"),
        "types.js" => include_str!("../assets/js/types.js"),
        "table.js" => include_str!("../assets/js/table.js"),
        "fields.js" => include_str!("../assets/js/fields.js"),
        "editors.js" => include_str!("../assets/js/editors.js"),
        "settings-media.js" => include_str!("../assets/js/settings-media.js"),
        "pages.js" => include_str!("../assets/js/pages.js"),
        "collections.js" => include_str!("../assets/js/collections.js"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        body,
    )
        .into_response()
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

/// SIGTERM 必须自己接：容器里 kalends 是 PID 1，而内核不会把默认处置的信号投给 PID 1，
/// 于是 `docker stop` 的 SIGTERM 被丢掉、恒等满超时再 SIGKILL。WAL 保得住数据，但每次
/// 重启都是硬杀，正好砸在那些多步写的中间。
async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("cannot listen for SIGTERM: {e}");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::util::ServiceExt;

    fn gated_app(conn: rusqlite::Connection) -> Router {
        let app = App {
            db: Arc::new(Mutex::new(conn)),
            data_dir: PathBuf::from("."),
            modules: Vec::new(),
        };
        Router::new()
            .route("/api/ping", get(|| async { "pong" }))
            .with_state(app.clone())
            .layer(middleware::from_fn_with_state(app, pin_gate))
    }

    async fn status_of(app: Router, req: Request<Body>) -> StatusCode {
        app.oneshot(req).await.unwrap().status()
    }

    /// PIN 门必须**故障即关死**：把"读不出设置"折成"没设 PIN"，settings 表一坏，
    /// 受保护的接口就从 401 变成 200——修复前这条测试的观测值正是 200。
    #[tokio::test]
    async fn the_pin_gate_fails_closed_when_settings_cannot_be_read() {
        let ping = || Request::get("/api/ping").body(Body::empty()).unwrap();
        // 没设 PIN：放行
        let conn = db::fresh_in_memory().unwrap();
        assert_eq!(status_of(gated_app(conn), ping()).await, StatusCode::OK);

        // 设了 PIN：不带凭据 401，带对了放行
        let conn = db::fresh_in_memory().unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('auth.pin','1234')", [])
            .unwrap();
        let app = gated_app(conn);
        assert_eq!(status_of(app.clone(), ping()).await, StatusCode::UNAUTHORIZED);
        let with_pin = Request::get("/api/ping")
            .header("x-kalends-pin", "1234")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_of(app, with_pin).await, StatusCode::OK);

        // settings 表读不出来：503，绝不能放行
        let conn = db::fresh_in_memory().unwrap();
        conn.execute_batch("DROP TABLE settings").unwrap();
        assert_eq!(
            status_of(gated_app(conn), ping()).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
