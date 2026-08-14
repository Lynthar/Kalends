use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::params;
use serde_json::{json, Value};

use crate::{db, engine, ics, notify, App};

pub struct ApiError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

/// 请求本身有问题（参数不合法 / 目标不存在），与服务端故障区分开。
/// 默认仍是 500：只有明确判定为客户端错误的才降级，别把真故障也说成客户端的锅。
#[derive(Debug)]
pub struct ClientError {
    status: StatusCode,
    msg: String,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for ClientError {}

/// 参数不合法 → 400
pub fn bad(msg: impl Into<String>) -> anyhow::Error {
    ClientError { status: StatusCode::BAD_REQUEST, msg: msg.into() }.into()
}

/// 目标不存在 → 404
pub fn missing(msg: impl Into<String>) -> anyhow::Error {
    ClientError { status: StatusCode::NOT_FOUND, msg: msg.into() }.into()
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self
            .0
            .downcast_ref::<ClientError>()
            .map_or(StatusCode::INTERNAL_SERVER_ERROR, |e| e.status);
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::warn!("api error: {:#}", self.0); // 真故障要留痕，客户端传错不必刷屏
        }
        (status, Json(json!({ "error": self.0.to_string() }))).into_response()
    }
}

pub type R = Result<Json<Value>, ApiError>;

pub fn core_router() -> Router<App> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/settings", get(settings_get).put(settings_put))
        .route("/api/backup", post(backup_run))
}

pub fn renewals_router() -> Router<App> {
    Router::new()
        .route("/api/overview", get(overview))
        .route("/api/fx", get(fx_get))
        .route("/api/fx/refresh", post(fx_refresh))
        .route("/api/ledger", get(ledger_list))
        .route("/api/notify/test", post(notify_test))
        .route("/calendar.ics", get(calendar))
        .merge(crate::collections::router())
}

pub fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(|x| x.as_str())
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
}

pub fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}

pub fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64())
}

/// 数据目录里可直接读写的文件名：只放行字母数字与 . _ -，因此拼不出路径分隔符或 `..` 之外的花样。
/// logo 与 cover 两条静态路径、以及删文件时都走它。
pub fn safe_name(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// 自定义列挂载点：body.extra 仅接受对象，存 JSON 文本
pub fn extra_str(v: &Value) -> Option<String> {
    v.get("extra").filter(|x| x.is_object()).map(|x| x.to_string())
}

// 读侧：extra 文本解析为对象，空/坏值给 {}
pub fn extra_json(text: Option<String>) -> Value {
    text.and_then(|x| serde_json::from_str::<Value>(&x).ok())
        .filter(|x| x.is_object())
        .unwrap_or_else(|| json!({}))
}

async fn health(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap_or(-1)
    };
    Ok(Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "modules": app.modules,
        "counts": {
            "collections": count("collections"),
            "items": count("items"),
            "media_items": count("media_items"),
            "renewal_ledger": count("renewal_ledger"),
        }
    })))
}

async fn overview(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!({
        "today": engine::today().to_string(),
        "upcoming": engine::upcoming(&conn)?,
        // 该上时间线却算不出到期日的：不点名的话它们会从界面上静默消失
        "undated": engine::undated(&conn)?,
        "totals": engine::totals(&conn)?,
        // 该计支出却缺了金额/币种/周期里的一项，于是一分钱没进总额的：同样要点名
        "uncounted": engine::uncounted(&conn)?,
        // 到期时间线里的 kind 是库键，前端要靠这份清单显示库名与到期动作说法
        "collections": crate::collections::collections(&conn)?,
    })))
}

/// 生效中的汇率表 + 显示币种。折算全在呈现层做，所以整张表下发给前端。
async fn fx_get(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(crate::fx::state(&conn)))
}

/// 手动拉一次实时汇率（默认关着的那条出网，用户在设置页点一下才发生）。
async fn fx_refresh(State(app): State<App>) -> R {
    Ok(Json(crate::fx::refresh(&app.db).await?))
}

/// 续费台账，给设置页的只读列表用。
///
/// 名字以**写入时钉进去的那份快照**为准（迁移 0018 起每笔都记）：只按 (kind, item_id)
/// 回查当前条目的话，条目一删这笔账就没了名字，而 items 的 id 会被 SQLite 复用——
/// 「删掉旧条目、在同一个库里再建一条」会让旧账挂到新条目名下（实测复现过）。
/// 快照为空的是 0018 之前、且条目当时已删的老账，回查一次仍然读不到就交给界面回落成编号。
async fn ledger_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT l.id, l.kind, l.item_id, l.renewed_at, l.amount, l.currency, l.note,
                coalesce(l.coll_name, c.name),
                coalesce(l.item_name,
                  (SELECT i.name FROM items i WHERE i.id = l.item_id AND i.collection_id = c.id))
         FROM renewal_ledger l LEFT JOIN collections c ON c.key = l.kind
         ORDER BY l.renewed_at DESC, l.id DESC LIMIT 500",
    )?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "kind": r.get::<_, String>(1)?,
                "item_id": r.get::<_, i64>(2)?,
                "renewed_at": r.get::<_, String>(3)?,
                "amount": r.get::<_, Option<f64>>(4)?,
                "currency": r.get::<_, Option<String>>(5)?,
                "note": r.get::<_, Option<String>>(6)?,
                "coll_name": r.get::<_, Option<String>>(7)?,
                "item_name": r.get::<_, Option<String>>(8)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Json(json!(rows)))
}

async fn settings_get(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT key,value FROM settings")?;
    let mut out = serde_json::Map::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (k, v) = row?;
        out.insert(k, Value::String(v));
    }
    Ok(Json(Value::Object(out)))
}

/// 一次请求里的设置要么全落、要么一条不落。
///
/// 曾经是边校验边写：前几个键已经生效、后一个键不是字符串就 400 返回，用户看到的是
/// 「保存失败」而设置已经改了一半（实测复现过）。所以先把整份校验完，再在一个事务里写。
async fn settings_put(State(app): State<App>, Json(b): Json<Value>) -> R {
    let obj = b.as_object().ok_or_else(|| bad("需要对象"))?;
    let mut pairs = Vec::with_capacity(obj.len());
    for (k, v) in obj {
        let val = v.as_str().ok_or_else(|| bad(format!("{k} 的值必须是字符串")))?;
        pairs.push((k, val));
    }
    let conn = app.db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    for (k, val) in pairs {
        tx.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![k, val],
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

async fn backup_run(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let report = crate::backup::run(&conn, &app.data_dir)?;
    Ok(Json(json!({
        "snapshot": report.snapshot.display().to_string(),
        "export_dir": report.export_dir.display().to_string(),
        "rotated_out": report.removed,
    })))
}

async fn notify_test(State(app): State<App>, Json(b): Json<Value>) -> R {
    let channel = s(&b, "channel").ok_or_else(|| bad("缺少 channel"))?;
    let (tg, mail) = {
        let conn = app.db.lock().unwrap();
        (notify::telegram_cfg(&conn), notify::email_cfg(&conn))
    };
    let text = "Kalends 通知测试 ✓";
    match channel.as_str() {
        "telegram" => {
            let cfg = tg.ok_or_else(|| bad("Telegram 未启用或未配置完整"))?;
            notify::send_telegram(&cfg, text).await?;
        }
        "email" => {
            let cfg = mail.ok_or_else(|| bad("邮件未启用或未配置完整"))?;
            notify::send_email(&cfg, "Kalends 通知测试", text).await?;
        }
        other => return Err(bad(format!("未知渠道：{other}")).into()),
    }
    Ok(Json(json!({ "ok": true })))
}

async fn calendar(
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let conn = app.db.lock().unwrap();
    let expected = db::get_setting(&conn, "ics.token").unwrap_or_default();
    if expected.is_empty() || q.get("token").map(String::as_str) != Some(expected.as_str()) {
        return Ok((StatusCode::UNAUTHORIZED, "unauthorized").into_response());
    }
    let body = ics::calendar(&engine::upcoming(&conn)?);
    Ok((
        [(header::CONTENT_TYPE, "text/calendar; charset=utf-8")],
        body,
    )
        .into_response())
}
