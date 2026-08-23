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

#[derive(Debug)] // 错误类型该是 Debug 的；测试里 unwrap 一个 Result<_, ApiError> 也要靠它
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

/// 类型校验，**只作用于这次请求里出现的键**：取值函数（`s`/`f`/`i`）读不出来就给 None，
/// 「出现即写入」的协议下那是一次静默清空，还回 200。`""` 与 `null` 仍按协议表示清空；
/// `extra` 出现时必须是对象（`""`/`null` 同样算清空）。
pub fn check_shape(b: &Value, strs: &[&str], ints: &[&str], reals: &[&str]) -> anyhow::Result<()> {
    let clearing = |v: &&Value| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty());
    for k in strs {
        if let Some(v) = b.get(*k).filter(|v| !clearing(v)) {
            if !v.is_string() {
                return Err(bad(format!("{k} 要写成文本")));
            }
        }
    }
    for k in ints {
        if let Some(v) = b.get(*k).filter(|v| !clearing(v)) {
            if v.as_i64().is_none() {
                return Err(bad(format!("{k} 要写成整数")));
            }
        }
    }
    for k in reals {
        if let Some(v) = b.get(*k).filter(|v| !clearing(v)) {
            if v.as_f64().is_none() {
                return Err(bad(format!("{k} 要写成数字")));
            }
        }
    }
    if let Some(v) = b.get("extra").filter(|v| !clearing(v)) {
        if !v.is_object() {
            return Err(bad("extra 要是对象"));
        }
    }
    Ok(())
}

/// 健康详情。任何一张表读不出来就 ok=false——状态码必须跟着变：容器探针与监控只看
/// 状态码，200 + ok:true 会把缺表的实例标成健康（`--health` 的判据是 <500，PIN 的 401 仍算活）。
pub(crate) fn health_payload(conn: &rusqlite::Connection, modules: &[String]) -> (bool, Value) {
    let count = |table: &str| -> Option<i64> {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .ok()
    };
    let tables = ["collections", "items", "media_items", "renewal_ledger"];
    let counts: Vec<(&str, Option<i64>)> = tables.iter().map(|t| (*t, count(t))).collect();
    let ok = counts.iter().all(|(_, n)| n.is_some());
    let counts: serde_json::Map<String, Value> = counts
        .into_iter()
        .map(|(t, n)| (t.to_string(), json!(n.unwrap_or(-1))))
        .collect();
    let payload = json!({
        "ok": ok,
        "version": env!("CARGO_PKG_VERSION"),
        "modules": modules,
        "counts": counts,
    });
    (ok, payload)
}

async fn health(State(app): State<App>) -> Response {
    let conn = app.db.lock().unwrap();
    let (ok, payload) = health_payload(&conn, &app.modules);
    let status = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(payload)).into_response()
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

/// 续费台账（设置页只读列表）。名字以**写入时钉进去的快照**为准（迁移 0018）：
/// 回查当前条目的话，条目一删账就没了名字，id 复用后旧账还会挂到新条目名下。
/// 快照为空的老账回查一次，仍读不到就交给界面回落成编号。
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

/// 一次请求里的设置要么全落、要么一条不落：先把整份校验完，再在一个事务里写——
/// 边校验边写会留下"报错了、设置却已改了一半"。
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 传错类型必须报错，不能落成 None 再被写成 NULL——「出现即写入」的协议下
    /// 那是一次静默清空，界面上还显示保存成功。
    #[test]
    fn a_wrongly_typed_key_is_refused_not_read_as_absent() {
        let strs = ["name"];
        let ints = ["cycle_days"];
        let reals = ["price"];
        let chk = |b: &Value| check_shape(b, &strs, &ints, &reals);
        assert!(chk(&json!({ "name": "文本", "cycle_days": 30, "price": 9.5 })).is_ok());
        assert!(chk(&json!({ "name": 123 })).is_err());
        assert!(chk(&json!({ "cycle_days": "三十" })).is_err());
        assert!(chk(&json!({ "cycle_days": 2.5 })).is_err());
        assert!(chk(&json!({ "price": "不是数字" })).is_err());
        assert!(chk(&json!({ "extra": ["不是对象"] })).is_err());
        assert!(chk(&json!({ "extra": "也不是" })).is_err());
        // 清空按协议来：null 与空串都算；缺席的键与未列出的键都不校验
        assert!(chk(&json!({ "name": null, "cycle_days": "", "price": null, "extra": null })).is_ok());
        assert!(chk(&json!({ "due": "只读键随便传" })).is_ok());
        assert!(chk(&json!({})).is_ok());
    }

    /// 缺表时 ok 必须翻假（状态码随之 503）：200 + ok:true 会让容器探针把
    /// 结构损坏的实例标成健康，监控与自动发布全被骗过。
    #[test]
    fn health_reports_false_when_a_table_cannot_be_read() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let modules = vec!["renewals".to_string()];
        let (ok, payload) = health_payload(&conn, &modules);
        assert!(ok);
        assert!(payload["counts"]["items"].as_i64().unwrap() >= 0);

        conn.execute_batch("DROP TABLE items").unwrap();
        let (ok, payload) = health_payload(&conn, &modules);
        assert!(!ok, "缺表还报健康就是骗探针");
        assert_eq!(payload["ok"], json!(false));
        assert_eq!(payload["counts"]["items"], json!(-1));
    }
}
