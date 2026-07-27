use std::collections::HashMap;

use anyhow::anyhow;
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

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": self.0.to_string() })),
        )
            .into_response()
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
        "totals": engine::totals(&conn)?,
        // 到期时间线里的 kind 是库键，前端要靠这份清单显示库名与到期动作说法
        "collections": crate::collections::collections(&conn)?,
    })))
}

async fn ledger_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id,kind,item_id,renewed_at,amount,currency,note FROM renewal_ledger
         ORDER BY renewed_at DESC, id DESC LIMIT 500",
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

async fn settings_put(State(app): State<App>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let obj = b.as_object().ok_or_else(|| anyhow!("需要对象"))?;
    for (k, v) in obj {
        let val = v.as_str().ok_or_else(|| anyhow!("值必须是字符串"))?;
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![k, val],
        )?;
    }
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
    let channel = s(&b, "channel").ok_or_else(|| anyhow!("缺少 channel"))?;
    let (tg, mail) = {
        let conn = app.db.lock().unwrap();
        (notify::telegram_cfg(&conn), notify::email_cfg(&conn))
    };
    let text = "Kalends 通知测试 ✓";
    match channel.as_str() {
        "telegram" => {
            let cfg = tg.ok_or_else(|| anyhow!("Telegram 未启用或未配置完整"))?;
            notify::send_telegram(&cfg, text).await?;
        }
        "email" => {
            let cfg = mail.ok_or_else(|| anyhow!("邮件未启用或未配置完整"))?;
            notify::send_email(&cfg, "Kalends 通知测试", text).await?;
        }
        other => return Err(anyhow!("未知渠道：{other}").into()),
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
