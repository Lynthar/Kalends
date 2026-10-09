mod api;
mod backup;
mod collections;
mod db;
mod engine;
mod fields;
mod fx;
mod ics;
mod notify;
mod settings;

use std::{
    io::IsTerminal,
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

/// 没设 `KALENDS_ADDR` 时起服监听、`--health` 去连的地址。
const DEFAULT_ADDR: &str = "127.0.0.1:4180";

#[derive(Clone)]
pub struct App {
    pub db: Db,
    pub data_dir: PathBuf,
}

#[cfg(test)]
impl App {
    /// 把一个库连接包成路由状态。只给测试用。
    pub fn for_tests(conn: rusqlite::Connection, data_dir: &std::path::Path) -> Self {
        App { db: Arc::new(Mutex::new(conn)), data_dir: data_dir.to_path_buf() }
    }
}

/// 对路由发一次 JSON 请求，回状态码与响应体（体不是 JSON 时回 `Null`）。只给测试用。
#[cfg(test)]
async fn call(router: &Router, method: &str, path: &str, body: Option<serde_json::Value>) -> (StatusCode, serde_json::Value) {
    use tower::util::ServiceExt;
    let req = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.map_or_else(String::new, |b| b.to_string())))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

/// `kalends --health`：容器 HEALTHCHECK 自检（镜像里没有 curl / wget，为一件事装包
/// 不值当）。只认 200：任一业务表读不出时 `/api/health` 回 503，它不过 PIN 门。
async fn health_probe() -> ! {
    let addr = std::env::var("KALENDS_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.into());
    // 0.0.0.0 是监听地址不是可连地址（容器里恒是它）
    let target = addr.replace("0.0.0.0:", "127.0.0.1:").replace("[::]:", "[::1]:");
    // 连的是本机，环境代理变量不能把它绕走；超时赶在 HEALTHCHECK 的 --timeout=5s 之前，好留下自己的报错
    let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(4)).build();
    let sent = match client {
        Ok(c) => c.get(format!("http://{target}/api/health")).send().await,
        Err(e) => Err(e),
    };
    let alive = match sent {
        Ok(r) => r.status().is_success(),
        Err(e) => {
            eprintln!("health: {e}");
            false
        }
    };
    std::process::exit(if alive { 0 } else { 1 });
}

/// `kalends restore --from <快照> --to <新目录>`：装配并验证一个新数据目录。
/// 退出码：0=完整；1=失败或引用文件缺失（数据库本身完好，但条目图标会缺）；2=用法错误。
fn restore_cli(rest: &[String]) -> ! {
    fn usage() -> ! {
        eprintln!("用法：kalends restore --from <backups/snapshot-日期.db> --to <新数据目录>");
        std::process::exit(2);
    }
    let (mut from, mut to) = (None, None);
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--from" => from = it.next().cloned(),
            "--to" => to = it.next().cloned(),
            _ => usage(),
        }
    }
    let (Some(from), Some(to)) = (from, to) else { usage() };
    match backup::restore(std::path::Path::new(&from), std::path::Path::new(&to)) {
        Ok(r) => {
            let staleness = if r.pending > 0 {
                format!("启动时将自动迁移 {} 步", r.pending)
            } else {
                "已是当前版本".into()
            };
            println!("已恢复 {to}/kalends.db：integrity_check ok，user_version {}（{staleness}）", r.user_version);
            match &r.assets_from {
                Some(src) => {
                    // `--from backups/x.db` 这种相对写法推出来的原数据目录是空路径，即当前目录
                    let src = if src.as_os_str().is_empty() { std::path::Path::new(".") } else { src.as_path() };
                    println!("已从 {} 复制 logos/ 共 {} 个文件", src.display(), r.assets_copied);
                }
                None => println!("快照不在标准 backups/ 布局里，未能定位原数据目录：请手动复制 logos/"),
            }
            if r.missing.is_empty() {
                println!("引用核对：条目引用的图标全部在位（孤儿文件 {} 个，无碍）", r.orphans);
                std::process::exit(0);
            }
            println!("引用核对：{} 个引用文件缺失——数据库完好，但这些条目的图标会缺：", r.missing.len());
            for m in &r.missing {
                println!("  {m}");
            }
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("恢复失败：{e:#}");
            std::process::exit(1);
        }
    }
}

const USAGE: &str = "用法：
  kalends                                          起服（数据目录 KALENDS_DATA，监听 KALENDS_ADDR）
  kalends --health                                 自检，给容器 healthcheck 用
  kalends --version
  kalends restore --from <快照> --to <新数据目录>";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 只有不带参数才起服，其余形状认不得就退 2：起服第一步是迁移数据库
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => {}
        ["restore", ..] => restore_cli(&args[1..]),
        ["--health"] => health_probe().await,
        ["--version" | "-V"] => {
            println!("kalends {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        ["--help" | "-h"] => {
            println!("{USAGE}");
            return Ok(());
        }
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
    // 颜色只给终端：`docker logs` 与重定向到文件时转义序列就是满屏乱码
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_ansi(std::io::stdout().is_terminal())
        .init();

    // 先占端口再开库：同一份部署已在跑时，第二个进程在迁移之前就退出
    let addr: SocketAddr = std::env::var("KALENDS_ADDR")
        .unwrap_or_else(|_| DEFAULT_ADDR.into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let data_dir = PathBuf::from(std::env::var("KALENDS_DATA").unwrap_or_else(|_| "data".into()));
    let conn = db::open(&data_dir)?;
    db::seed_defaults(&conn)?;
    tracing::info!("database ready at {}", data_dir.join("kalends.db").display());
    // 到期日、剩余天数、摘要时刻、备份边界全看本地时区，而容器默认 UTC——「今天」会错位。
    // 启动时把本地时间、偏移与 TZ 原值打出来；拼错了或没设而落成 UTC 都告警，但不拒绝启动
    {
        let now = chrono::Local::now();
        let tz = std::env::var("TZ").ok();
        let at = now.format("%Y-%m-%d %H:%M (UTC%:z)");
        tracing::info!("local time {at}, TZ={}", tz.as_deref().unwrap_or("(unset)"));
        match tz.as_deref() {
            Some(t) if tz_unresolved(t) => {
                tracing::warn!("TZ={t} is not a time zone this system knows; local time fell back to {at}");
            }
            None if now.offset().local_minus_utc() == 0 => {
                tracing::warn!("TZ is not set and local time is UTC; set TZ so \"today\" follows your clock");
            }
            _ => {}
        }
    }

    let app = App {
        db: Arc::new(Mutex::new(conn)),
        data_dir: data_dir.clone(),
    };
    tokio::spawn(notify::scheduler(app.db.clone()));
    tokio::spawn(backup::scheduler(app.db.clone(), data_dir));

    let router = Router::new()
        .route("/", get(index))
        .route("/js/{name}", get(js_file))
        .route("/style.css", get(style_css))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.svg", get(icon))
        .merge(api::core_router())
        .merge(fields::router())
        .merge(api::renewals_router())
        .with_state(app.clone())
        .layer(middleware::from_fn_with_state(app, pin_gate));

    tracing::info!("listening on http://{addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// `TZ` 设了却既不在时区库里、也不是 POSIX 写法（如 `CST-8`）：chrono 这时静默回落，拼错的
/// `Asia/Shangai` 跑出来就是 UTC。查找的目录与 chrono 一致；空 `TZ` 按约定就是 UTC，不算。
fn tz_unresolved(tz: &str) -> bool {
    const ZONE_DIRS: [&str; 4] = ["/usr/share/zoneinfo", "/share/zoneinfo", "/etc/zoneinfo", "/usr/share/lib/zoneinfo"];
    if tz.is_empty() {
        return false;
    }
    let (file_only, name) = tz.strip_prefix(':').map_or((false, tz), |n| (true, n));
    let path = std::path::Path::new(name);
    let found = if path.is_absolute() {
        path.is_file()
    } else {
        ZONE_DIRS.iter().any(|d| std::path::Path::new(d).join(name).is_file())
    };
    let abbr = tz.chars().take_while(char::is_ascii_alphabetic).count();
    let posix = tz.starts_with('<')
        || (abbr >= 3 && tz[abbr..].starts_with(|c: char| c.is_ascii_digit() || c == '+' || c == '-'));
    !found && (file_only || !posix)
}

/// 设置 auth.pin 后，/api/* 与 /logos/* 需要 X-Kalends-Pin 头或 `kalends_pin` cookie；
/// 静态页与 /calendar.ics（自带令牌）不拦。`/api/health` 也不拦：放行的请求挂上
/// `api::PinPassed`，健康检查凭它决定回多少。
async fn pin_gate(State(app): State<App>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if !path.starts_with("/api") && !path.starts_with("/logos") {
        return next.run(req).await;
    }
    let health = path == "/api/health";
    let stored = {
        let conn = app.db.lock().unwrap();
        db::get_setting(&conn, "auth.pin")
    };
    let required = match stored {
        Ok(v) => v.unwrap_or_default(),
        // 健康检查自己数得到 settings 读不出、回 503，门不替它答话
        Err(_) if health => return next.run(req).await,
        // 读不出设置 ≠ 没设 PIN：把数据库故障折成空串，门会在最不该开的时候敞开
        Err(e) => {
            tracing::error!("pin gate cannot read settings: {e}");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "设置读不出来，先检查数据库" })),
            )
                .into_response();
        }
    };
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
    if required.is_empty() || header_ok || cookie_ok {
        req.extensions_mut().insert(api::PinPassed);
        next.run(req).await
    } else if health {
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
        "settings.js" => include_str!("../assets/js/settings.js"),
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
        let app = App::for_tests(conn, std::path::Path::new("."));
        Router::new()
            .route("/api/ping", get(|| async { "pong" }))
            .route("/logos/{name}", get(|| async { "png" }))
            .route("/calendar.ics", get(|| async { "ics" }))
            .route("/", get(|| async { "html" }))
            .with_state(app.clone())
            .layer(middleware::from_fn_with_state(app, pin_gate))
    }

    fn with_pin(pin: &str) -> rusqlite::Connection {
        let conn = db::fresh_in_memory().unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('auth.pin',?1)", [pin])
            .unwrap();
        conn
    }

    /// 门只覆盖 `/api` 与 `/logos`：静态页与自带令牌的 `/calendar.ics` 不拦。
    /// 拦错方向的话，要么首页要 PIN 才打得开，要么图标文件裸露。
    #[tokio::test]
    async fn the_pin_gate_covers_api_and_logos_and_nothing_else() {
        let app = gated_app(with_pin("1234"));
        let get = |p: &str| Request::get(p).body(Body::empty()).unwrap();
        assert_eq!(status_of(app.clone(), get("/")).await, StatusCode::OK);
        assert_eq!(status_of(app.clone(), get("/calendar.ics")).await, StatusCode::OK);
        assert_eq!(status_of(app.clone(), get("/logos/a.png")).await, StatusCode::UNAUTHORIZED);
        assert_eq!(status_of(app, get("/api/ping")).await, StatusCode::UNAUTHORIZED);
    }

    /// 凭据的另一条路是 `kalends_pin` cookie（设置页保存 PIN 时给本浏览器发的），
    /// 别的 cookie 混在一起也要认得出，值不对照样 401。
    #[tokio::test]
    async fn the_pin_cookie_is_accepted_only_when_it_matches() {
        let app = gated_app(with_pin("1234"));
        let with_cookie = |c: &str| {
            Request::get("/api/ping")
                .header(header::COOKIE, c)
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(status_of(app.clone(), with_cookie("kalends_pin=1234")).await, StatusCode::OK);
        assert_eq!(
            status_of(app.clone(), with_cookie("theme=dark; kalends_pin=1234")).await,
            StatusCode::OK
        );
        assert_eq!(status_of(app.clone(), with_cookie("kalends_pin=4321")).await, StatusCode::UNAUTHORIZED);
        assert_eq!(status_of(app, with_cookie("theme=dark")).await, StatusCode::UNAUTHORIZED);
    }

    /// 首页按依赖顺序加载八份脚本，`/js/{name}` 的 match 表必须一份不少地服务它们；
    /// 漏一份就是 404 白屏，认不得的名字要 404 而不是空 200。
    #[tokio::test]
    async fn the_page_loads_eight_scripts_in_order_and_each_one_is_served() {
        let html = index().await.0;
        let srcs: Vec<&str> = html
            .match_indices("src=\"/js/")
            .map(|(i, m)| {
                let rest = &html[i + m.len()..];
                &rest[..rest.find('"').unwrap()]
            })
            .collect();
        assert_eq!(
            srcs,
            ["core.js", "types.js", "table.js", "fields.js", "editors.js", "settings.js", "pages.js", "collections.js"]
        );
        for name in srcs {
            let resp = js_file(Path(name.to_string())).await;
            assert_eq!(resp.status(), StatusCode::OK, "{name}");
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            assert!(!body.is_empty(), "{name} 服务出来是空的");
        }
        assert_eq!(js_file(Path("nope.js".into())).await.status(), StatusCode::NOT_FOUND);
    }

    async fn status_of(app: Router, req: Request<Body>) -> StatusCode {
        app.oneshot(req).await.unwrap().status()
    }

    /// 拼错的时区名、找不到的文件要认出来（chrono 会静默回落）；POSIX 写法、空值与真有的时区不算。
    #[test]
    fn a_misspelled_tz_is_told_apart_from_the_forms_chrono_accepts() {
        for bad in ["Asia/Shangai", ":Asia/Shangai", "/nonexistent/zone", "Shanghai"] {
            assert!(tz_unresolved(bad), "{bad}");
        }
        for ok in ["", "CST-8", "UTC0", "EST5EDT,M3.2.0,M11.1.0", "<+08>-8", "Etc/GMT-14", "Asia/Shanghai"] {
            assert!(!tz_unresolved(ok), "{ok}");
        }
    }

    fn health_app(conn: rusqlite::Connection) -> Router {
        let app = App::for_tests(conn, std::path::Path::new("."));
        api::core_router()
            .with_state(app.clone())
            .layer(middleware::from_fn_with_state(app, pin_gate))
    }

    async fn health_of(app: Router, pin: Option<&str>) -> (StatusCode, serde_json::Value) {
        let mut req = Request::get("/api/health");
        if let Some(pin) = pin {
            req = req.header("x-kalends-pin", pin);
        }
        let resp = app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    /// 健康检查不过 PIN 门：容器探针不带凭据，过门的话设了 PIN 它只拿得到 401，表坏了
    /// 容器照样 healthy。没带对 PIN 只回状态码与 `{ok}`，计数与版本留给带凭据的人。
    #[tokio::test]
    async fn health_answers_without_the_pin_but_shows_counts_only_with_it() {
        let app = health_app(with_pin("1234"));
        let bare = (StatusCode::OK, json!({ "ok": true }));
        assert_eq!(health_of(app.clone(), None).await, bare);
        assert_eq!(health_of(app.clone(), Some("4321")).await, bare);
        let (status, body) = health_of(app.clone(), Some("1234")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["counts"]["items"].is_i64(), "{body}");
        let settings = Request::get("/api/settings").body(Body::empty()).unwrap();
        assert_eq!(status_of(app, settings).await, StatusCode::UNAUTHORIZED);

        // 没设 PIN：人人都算带了凭据
        let (_, body) = health_of(health_app(db::fresh_in_memory().unwrap()), None).await;
        assert!(body["counts"]["items"].is_i64(), "{body}");

        let down = (StatusCode::SERVICE_UNAVAILABLE, json!({ "ok": false }));
        let conn = with_pin("1234");
        conn.execute_batch("DROP TABLE notification_log").unwrap();
        assert_eq!(health_of(health_app(conn), None).await, down);
        // settings 读不出时门不替健康检查答话：形状同样是 {ok:false}
        let conn = db::fresh_in_memory().unwrap();
        conn.execute_batch("DROP TABLE settings").unwrap();
        assert_eq!(health_of(health_app(conn), None).await, down);
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
