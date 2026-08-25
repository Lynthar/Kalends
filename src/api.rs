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
        .route("/api/notify/log", get(notify_log))
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

/// 通知投递记录（最新 200 条），notification_log 唯一的读路径。covered 记账行原样吐出——
/// 去重语义的核对要靠这里看到全部行，过滤是呈现层的事；条目名回查当前条目，删了就取不到。
pub(crate) fn notify_log_rows(conn: &rusqlite::Connection) -> anyhow::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT l.id, l.kind, l.item_id, l.channel, l.threshold_days, l.due_date, l.sent_at, l.ok, l.error,
                (SELECT i.name FROM items i JOIN collections c ON c.id = i.collection_id
                  WHERE i.id = l.item_id AND c.key = l.kind)
         FROM notification_log l
         ORDER BY l.sent_at DESC, l.id DESC LIMIT 200",
    )?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "kind": r.get::<_, String>(1)?,
                "item_id": r.get::<_, Option<i64>>(2)?,
                "channel": r.get::<_, String>(3)?,
                "threshold_days": r.get::<_, Option<i64>>(4)?,
                "due_date": r.get::<_, String>(5)?,
                "sent_at": r.get::<_, String>(6)?,
                "ok": r.get::<_, i64>(7)? == 1,
                "error": r.get::<_, Option<String>>(8)?,
                "item_name": r.get::<_, Option<String>>(9)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

async fn notify_log(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!(notify_log_rows(&conn)?)))
}

/// 已知键按形状拦、不认识的键照存。只拦「一眼可辨的垃圾」——写坏了会静默出事的那几类
///（端口环绕、阈值解析失败回默认、空 ICS 令牌把日历开给所有人）；R3-#6 的拍板仍然成立：
/// 键白名单会把「漏登记的键」变成「永远存不进去且不报错」。
fn check_setting(k: &str, v: &str) -> anyhow::Result<()> {
    let int_in = |lo: i64, hi: i64, what: &str| {
        v.trim()
            .parse::<i64>()
            .ok()
            .filter(|n| (lo..=hi).contains(n))
            .map(|_| ())
            .ok_or_else(|| bad(format!("{what}要是 {lo}–{hi} 的整数")))
    };
    match k {
        "auth.pin" => (v.is_empty()
            || (v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric())))
        .then_some(())
        .ok_or_else(|| bad("PIN 只收字母与数字（至多 64 位）；留空＝不设门")),
        "notify.window_days" => int_in(1, 3650, "摘要窗口"),
        "ui.upcoming_days" => int_in(1, 3650, "到期窗口"),
        "notify.digest_time" => (v.is_ascii()
            && v.len() == 5
            && v.as_bytes()[2] == b':'
            && v[..2].parse::<u8>().is_ok_and(|h| h < 24)
            && v[3..].parse::<u8>().is_ok_and(|m| m < 60))
        .then_some(())
        .ok_or_else(|| bad("摘要时刻要是 HH:MM")),
        "notify.thresholds" => {
            let arr: Vec<i64> =
                serde_json::from_str(v).map_err(|_| bad("提醒阈值要是整数数组（可以为空）"))?;
            (arr.len() <= 32 && arr.iter().all(|n| (0..=3650).contains(n)))
                .then_some(())
                .ok_or_else(|| bad("提醒阈值每项要在 0–3650 天"))
        }
        "notify.telegram" | "notify.email" => {
            let o: Value = serde_json::from_str(v).map_err(|_| bad("渠道配置要是 JSON 对象"))?;
            let o = o.as_object().ok_or_else(|| bad("渠道配置要是 JSON 对象"))?;
            for (fk, fv) in o {
                let ok = match fk.as_str() {
                    "enabled" | "starttls" => fv.is_boolean(),
                    "port" => fv.is_u64(),
                    _ => fv.is_string(),
                };
                if !ok {
                    return Err(bad(format!("渠道配置 {fk} 的类型不对")));
                }
            }
            // 端口在写入口就拦：环绕成没人配过的端口号之后，读侧只能悄悄回落默认
            if let Some(p) = o.get("port") {
                p.as_u64()
                    .filter(|p| (1..=65535).contains(p))
                    .ok_or_else(|| bad("SMTP 端口要在 1–65535"))?;
            }
            Ok(())
        }
        "fx.display" => {
            let t = v.trim();
            (t.is_empty() || (t.len() == 3 && t.chars().all(|c| c.is_ascii_alphabetic())))
                .then_some(())
                .ok_or_else(|| bad("显示币种要是三位字母代码，留空＝不折算"))
        }
        "ics.token" => (!v.is_empty()
            && v.len() <= 128
            && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .then_some(())
        .ok_or_else(|| bad("ICS 令牌要是非空的 URL 安全字符串——空令牌等于把日历开给所有人")),
        "meta.proxy" => (v.is_empty() || v.contains("://"))
            .then_some(())
            .ok_or_else(|| bad("代理要是带协议的地址（如 socks5://…），留空＝直连")),
        _ => Ok(()),
    }
}

// 渠道密钥不回读明文：GET 把它换成占位串，PUT 收到占位串＝保持库里那份。
// 占位串在输入框里就是一排点，前端不必知道这套机制存在；清空照旧发 ""。
const SECRET_MASK: &str = "••••••••";

fn secret_field(k: &str) -> Option<&'static str> {
    match k {
        "notify.telegram" => Some("bot_token"),
        "notify.email" => Some("password"),
        _ => None,
    }
}

fn mask_secret(k: &str, stored: &str) -> String {
    let Some(field) = secret_field(k) else { return stored.into() };
    let Ok(mut v) = serde_json::from_str::<Value>(stored) else { return stored.into() };
    if v[field].as_str().is_some_and(|s| !s.is_empty()) {
        v[field] = Value::from(SECRET_MASK);
    }
    v.to_string()
}

fn keep_masked_secret(conn: &rusqlite::Connection, k: &str, incoming: &str) -> anyhow::Result<String> {
    let Some(field) = secret_field(k) else { return Ok(incoming.into()) };
    let Ok(mut v) = serde_json::from_str::<Value>(incoming) else { return Ok(incoming.into()) };
    if v[field].as_str() == Some(SECRET_MASK) {
        // 读不出旧值要报错别吞：把故障当"没存过"会把密钥静默清空
        let stored = crate::db::get_setting_checked(conn, k)?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|s| s[field].as_str().map(str::to_string))
            .unwrap_or_default();
        v[field] = Value::from(stored);
    }
    Ok(v.to_string())
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
        let masked = mask_secret(&k, &v);
        out.insert(k, Value::String(masked));
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
        check_setting(k, val)?;
        pairs.push((k, val));
    }
    let conn = app.db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    for (k, val) in pairs {
        let val = keep_masked_secret(&tx, k, val)?;
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

    /// 已知键拦一眼可辨的垃圾，不认识的键照存——R3-#6 的拍板：不做键白名单，
    /// 漏登记的键「存不进去且不报错」比存进垃圾更糟。
    #[test]
    fn known_settings_are_shape_checked_and_unknown_keys_pass() {
        let ok = |k, v| assert!(check_setting(k, v).is_ok(), "{k}={v}");
        let no = |k, v| assert!(check_setting(k, v).is_err(), "{k}={v}");
        ok("auth.pin", "");
        ok("auth.pin", "1a2B");
        no("auth.pin", "p@ss");
        ok("notify.window_days", "14");
        no("notify.window_days", "0");
        no("notify.window_days", "x");
        ok("notify.digest_time", "09:00");
        no("notify.digest_time", "9:00");
        no("notify.digest_time", "24:00");
        ok("notify.thresholds", "[]");
        ok("notify.thresholds", "[14,7,0]");
        no("notify.thresholds", r#"["a"]"#);
        no("notify.thresholds", "14,7");
        ok("notify.email", r#"{"enabled":true,"port":465,"password":"x"}"#);
        no("notify.email", r#"{"port":70000}"#);
        no("notify.email", r#"{"port":0}"#);
        no("notify.email", r#"{"enabled":"yes"}"#);
        no("notify.telegram", "not json");
        ok("fx.display", "");
        ok("fx.display", " cny ");
        no("fx.display", "yuan");
        ok("ics.token", "abcDEF123_-");
        no("ics.token", "");
        no("ics.token", "白");
        ok("meta.proxy", "");
        ok("meta.proxy", "socks5://127.0.0.1:1080");
        no("meta.proxy", "12345");
        ok("some.future_key", "anything at all");
    }

    /// 渠道密钥不回读明文：GET 换占位串；PUT 收占位串＝保持、收新值＝更新、收空串＝清掉。
    #[test]
    fn channel_secrets_mask_on_read_and_keep_on_masked_write() {
        let conn = crate::db::fresh_in_memory().unwrap();
        conn.execute(
            "INSERT INTO settings(key,value) VALUES('notify.telegram',?1)",
            [r#"{"enabled":true,"bot_token":"tok123","chat_id":"1"}"#],
        )
        .unwrap();
        let stored = crate::db::get_setting(&conn, "notify.telegram").unwrap();
        let masked = mask_secret("notify.telegram", &stored);
        assert!(!masked.contains("tok123") && masked.contains(SECRET_MASK), "{masked}");
        let kept = keep_masked_secret(&conn, "notify.telegram", &masked).unwrap();
        assert!(kept.contains("tok123"), "{kept}");
        let fresh = keep_masked_secret(&conn, "notify.telegram", r#"{"bot_token":"new"}"#).unwrap();
        assert!(fresh.contains("new") && !fresh.contains("tok123"));
        let cleared = keep_masked_secret(&conn, "notify.telegram", r#"{"bot_token":""}"#).unwrap();
        assert!(!cleared.contains("tok123"));
        // 空 token 不上占位串（否则看起来像已配置）；无密钥可藏的键原样通过
        assert!(!mask_secret("notify.telegram", r#"{"bot_token":""}"#).contains(SECRET_MASK));
        assert_eq!(secret_field("notify.email"), Some("password"));
        assert_eq!(mask_secret("fx.display", "CNY"), "CNY");
    }

    /// 通知记录是 notification_log 唯一的读路径：最新在前、covered 行不缺席、
    /// 条目名回查得到就带上；条目删了名字取不到，回落为 null 而不是错行。
    #[test]
    fn the_notify_log_reads_back_everything_including_covered_rows() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll: i64 = conn
            .query_row("SELECT id FROM collections WHERE key='subs'", [], |r| r.get(0))
            .unwrap();
        let id = crate::collections::insert_item(&conn, coll, &json!({ "name": "Example" })).unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO notification_log(kind,item_id,channel,threshold_days,due_date,sent_at,ok,error) VALUES
               ('subs',{id},'telegram',7,'2026-09-01','2026-08-25 01:00:00',1,NULL),
               ('subs',{id},'telegram',14,'2026-09-01','2026-08-25 01:00:00',1,'covered'),
               ('subs',999,'telegram',3,'2026-09-01','2026-08-25 02:00:00',0,'boom')"
        ))
        .unwrap();
        let rows = notify_log_rows(&conn).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["ok"], json!(false)); // 最新在前
        assert_eq!(rows[0]["error"], json!("boom"));
        assert_eq!(rows[0]["item_name"], json!(null)); // 查无此条目
        assert!(rows.iter().any(|r| r["error"] == json!("covered")));
        assert!(rows.iter().any(|r| r["item_name"] == json!("Example")));
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
