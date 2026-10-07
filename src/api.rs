use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use rusqlite::params;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use crate::{db, engine, ics, notify, settings, App};

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
        .route("/api/settings/defaults", get(settings_defaults))
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
    v.get(k).and_then(Value::as_f64)
}

pub fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_i64)
}

/// 数据目录里可直接读写的文件名：只放行字母数字与 . _ -，因此拼不出路径分隔符或 `..` 之外的花样。
/// `/logos/{name}` 静态路径与删文件时都走它。
pub fn safe_name(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// 自定义列挂载点：body.extra 仅接受对象，存 JSON 文本
pub fn extra_str(v: &Value) -> Option<String> {
    v.get("extra").filter(|x| x.is_object()).map(ToString::to_string)
}

// 读侧：extra 文本解析为对象，空/坏值给 {}
pub fn extra_json(text: Option<String>) -> Value {
    text.and_then(|x| serde_json::from_str::<Value>(&x).ok())
        .filter(Value::is_object)
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

/// 健康详情。任何一张业务表读不出来就 ok=false——状态码必须跟着变：容器探针与监控只看
/// 状态码，200 + ok:true 会把缺表的实例标成健康。计数带 `NOT INDEXED`：默认走覆盖索引，
/// 表页坏了、索引完好时照样数得出来。
pub(crate) fn health_payload(conn: &rusqlite::Connection) -> (bool, Value) {
    let count = |table: &str| -> Option<i64> {
        conn.query_row(&format!("SELECT count(*) FROM {table} NOT INDEXED"), [], |r| r.get(0))
            .ok()
    };
    let tables = ["collections", "items", "fields", "renewal_ledger", "notification_log", "settings"];
    let counts: Vec<(&str, Option<i64>)> = tables.iter().map(|t| (*t, count(t))).collect();
    let ok = counts.iter().all(|(_, n)| n.is_some());
    let counts: serde_json::Map<String, Value> = counts
        .into_iter()
        .map(|(t, n)| (t.to_string(), json!(n.unwrap_or(-1))))
        .collect();
    let payload = json!({
        "ok": ok,
        "version": env!("CARGO_PKG_VERSION"),
        "counts": counts,
    });
    (ok, payload)
}

/// PIN 门放行时挂在请求上的标记（没设 PIN 也算放行）。健康检查不过门，靠它决定回多少。
#[derive(Clone)]
pub struct PinPassed;

/// 不过 PIN 门（容器探针不带凭据）；没带对 PIN 只回状态码与 `{ok}`，计数与版本留给带凭据的人。
async fn health(State(app): State<App>, passed: Option<Extension<PinPassed>>) -> Response {
    let conn = app.db.lock().unwrap();
    let (ok, payload) = health_payload(&conn);
    let status = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    let body = if passed.is_some() { payload } else { json!({ "ok": ok }) };
    (status, Json(body)).into_response()
}

async fn overview(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!({
        "today": engine::today().to_string(),
        "upcoming": engine::upcoming(&conn)?,
        // 该上时间线却算不出到期日的：不点名的话它们会从界面上静默消失
        "undated": engine::undated(&conn)?,
        // 有到期日、状态却不上时间线的（新建条目默认的 Planned 就是）：同理点名
        "off_timeline": engine::off_timeline(&conn)?,
        // 状态不在所属库词表里的：写入口照收（导入要能先进来），语义只能回落，同样点名
        "unknown_status": engine::unknown_status(&conn)?,
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
    Ok(Json(crate::fx::state(&conn)?))
}

/// 手动拉一次实时汇率（默认关着的那条出网，用户在设置页点一下才发生）。
async fn fx_refresh(State(app): State<App>) -> R {
    Ok(Json(crate::fx::refresh(&app.db).await?))
}

/// 续费台账（设置页只读列表）。名字以**写入时钉进去的快照**为准（迁移 0018）：
/// 回查当前条目的话，条目一删账就没了名字；迁移 0021 之前 id 会被复用，老账还可能挂到新条目名下。
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

/// 通知投递记录（最新 200 条），`notification_log` 唯一的读路径。covered 记账行原样吐出——
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

/// 已知键按形状拦、不认识的键照存：键白名单会把「漏登记的键」变成
/// 「永远存不进去且不报错」。每个键的规则在 `settings::SPECS`。
fn check_setting(k: &str, v: &str) -> anyhow::Result<()> {
    settings::spec(k).map_or(Ok(()), |s| (s.check)(v))
}

// 渠道密钥不回读明文：GET 把它换成占位串（`settings::masked`），PUT 收到占位串＝保持库里那份；
// 清空照旧发 ""。
fn keep_masked_secret(conn: &rusqlite::Connection, k: &str, incoming: &str) -> anyhow::Result<String> {
    let Some(field) = settings::secret_field(k) else { return Ok(incoming.into()) };
    let Ok(mut v) = serde_json::from_str::<Value>(incoming) else { return Ok(incoming.into()) };
    if v[field].as_str() == Some(settings::SECRET_MASK) {
        // 读不出旧值要报错别吞：把故障当"没存过"会把密钥静默清空
        let stored = crate::db::get_setting(conn, k)?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|s| s[field].as_str().map(str::to_string))
            .unwrap_or_default();
        v[field] = Value::from(stored);
    }
    Ok(v.to_string())
}

/// 固定默认值下发给前端：表单的占位串与「清空＝回默认」都读它，JS 里不再抄一份。
async fn settings_defaults() -> R {
    Ok(Json(settings::defaults_json()))
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
        let masked = settings::masked(&k, &v);
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
        // 存的就是判过的那份：校验 trim 过、落库却原样的话，读侧（不 trim）解析不出、静默回落成默认
        let val = v.as_str().ok_or_else(|| bad(format!("{k} 的值必须是字符串")))?.trim();
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

/// 发送测试测哪份配置：请求带了 `config`（表单里该渠道的当前值）就测它、不落盘，其中的占位串
/// 换回库里那份密钥；没带就测库里存着的。
fn test_config(conn: &rusqlite::Connection, key: &str, config: Option<&Value>) -> anyhow::Result<String> {
    let Some(v) = config else {
        return Ok(db::get_setting(conn, key)?.unwrap_or_default());
    };
    let v = v.as_str().ok_or_else(|| bad("config 要是字符串"))?;
    check_setting(key, v)?;
    keep_masked_secret(conn, key, v)
}

async fn notify_test(State(app): State<App>, Json(b): Json<Value>) -> R {
    let channel = s(&b, "channel").ok_or_else(|| bad("缺少 channel"))?;
    let raw = |key| {
        let conn = app.db.lock().unwrap();
        test_config(&conn, key, b.get("config"))
    };
    let text = "Kalends 通知测试 ✓";
    match channel.as_str() {
        "telegram" => {
            let cfg = notify::telegram_cfg_from(&raw("notify.telegram")?)
                .ok_or_else(|| bad("Telegram 未启用或未配置完整"))?;
            notify::send_telegram(&cfg, text).await?;
        }
        "email" => {
            let cfg = notify::email_cfg_from(&raw("notify.email")?).ok_or_else(|| bad("邮件未启用或未配置完整"))?;
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
    let expected = db::get_setting(&conn, "ics.token")?.unwrap_or_default();
    if !token_ok(q.get("token").map(String::as_str), &expected) {
        return Ok((StatusCode::UNAUTHORIZED, "unauthorized").into_response());
    }
    let body = ics::calendar(&engine::upcoming(&conn)?);
    Ok((
        [(header::CONTENT_TYPE, "text/calendar; charset=utf-8")],
        body,
    )
        .into_response())
}

/// 令牌比对走常数时间：`!=` 在第一个不同字节就返回，响应时间会泄露前缀对了几位。
/// 没设令牌（空串）谁都不能过——空对空也不行。
fn token_ok(given: Option<&str>, expected: &str) -> bool {
    !expected.is_empty()
        && given.is_some_and(|g| bool::from(g.as_bytes().ct_eq(expected.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_calendar_token_must_be_set_and_match_exactly() {
        assert!(token_ok(Some("abc"), "abc"));
        assert!(!token_ok(Some("abd"), "abc"));
        assert!(!token_ok(Some("ab"), "abc"));
        assert!(!token_ok(Some("abcd"), "abc"));
        assert!(!token_ok(None, "abc"));
        assert!(!token_ok(Some(""), ""), "没设令牌时空对空也不能过");
        assert!(!token_ok(None, ""));
    }

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

    /// 已知键拦一眼可辨的垃圾，不认识的键照存——不做键白名单：漏登记的键「存不进去且不报错」
    /// 比存进垃圾更糟。
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
        ok("ui.upcoming_days", "30");
        ok("ui.upcoming_days", "all");
        no("ui.upcoming_days", "forever");
        no("ui.upcoming_days", "0");
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
        let stored = crate::db::get_setting(&conn, "notify.telegram").unwrap().unwrap();
        let masked = settings::masked("notify.telegram", &stored);
        assert!(!masked.contains("tok123") && masked.contains(settings::SECRET_MASK), "{masked}");
        let kept = keep_masked_secret(&conn, "notify.telegram", &masked).unwrap();
        assert!(kept.contains("tok123"), "{kept}");
        let fresh = keep_masked_secret(&conn, "notify.telegram", r#"{"bot_token":"new"}"#).unwrap();
        assert!(fresh.contains("new") && !fresh.contains("tok123"));
        let cleared = keep_masked_secret(&conn, "notify.telegram", r#"{"bot_token":""}"#).unwrap();
        assert!(!cleared.contains("tok123"));
        // 空 token 不上占位串（否则看起来像已配置）；无密钥可藏的键原样通过
        assert!(!settings::masked("notify.telegram", r#"{"bot_token":""}"#).contains(settings::SECRET_MASK));
        assert_eq!(settings::secret_field("notify.email"), Some("password"));
        assert_eq!(settings::masked("fx.display", "CNY"), "CNY");
        // 存值解析不出时整串换掉：原样吐出就是连密钥一起交出去
        assert_eq!(settings::masked("notify.telegram", r#"{"bot_token":"tok123""#), settings::SECRET_MASK);
    }

    /// 设置存 trim 后的值：校验判的是 trim 过的，原样落库的话读侧（不 trim）解析不出、静默回落成
    /// 默认——存 " 30 " 回 200，调度器用的却是 14。
    #[tokio::test]
    async fn settings_are_stored_as_the_trimmed_value_that_was_checked() {
        use axum::body::Body;
        use tower::util::ServiceExt;
        let app = App::for_tests(crate::db::fresh_in_memory().unwrap(), std::path::Path::new("."));
        let req = axum::http::Request::put("/api/settings")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"notify.window_days":" 30 ","notify.digest_time":" 08:30"}"#))
            .unwrap();
        let resp = core_router().with_state(app.clone()).oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let conn = app.db.lock().unwrap();
        let get = |k| crate::db::get_setting(&conn, k).unwrap().unwrap();
        assert_eq!(get("notify.window_days").parse::<i64>().ok(), Some(30));
        assert_eq!(get("notify.digest_time"), "08:30");
    }

    /// 发送测试测表单里的当前值：带来的占位串换回库里那份密钥，坏形状拒收；不带 config 测库里存着的。
    #[test]
    fn the_send_test_takes_the_form_values_with_the_stored_secret_behind_the_mask() {
        let conn = crate::db::fresh_in_memory().unwrap();
        crate::db::seed_defaults(&conn).unwrap();
        let key = "notify.telegram";
        conn.execute(
            "UPDATE settings SET value=?2 WHERE key=?1",
            [key, r#"{"enabled":true,"bot_token":"STORED","chat_id":"1"}"#],
        )
        .unwrap();
        let tg = |config: Option<&Value>| notify::telegram_cfg_from(&test_config(&conn, key, config).unwrap()).unwrap();

        let form = json!(format!(r#"{{"enabled":true,"bot_token":"{}","chat_id":"2"}}"#, settings::SECRET_MASK));
        let cfg = tg(Some(&form));
        assert_eq!((cfg.bot_token.as_str(), cfg.chat_id.as_str()), ("STORED", "2"));
        let cfg = tg(Some(&json!(r#"{"enabled":true,"bot_token":"TYPED","chat_id":"2"}"#)));
        assert_eq!(cfg.bot_token, "TYPED");
        let cfg = tg(None);
        assert_eq!((cfg.bot_token.as_str(), cfg.chat_id.as_str()), ("STORED", "1"));
        assert!(test_config(&conn, key, Some(&json!("不是 JSON"))).is_err());
        assert!(test_config(&conn, key, Some(&json!({ "enabled": true }))).is_err(), "config 是串，与设置接口同形");
    }

    /// 通知记录是 `notification_log` 唯一的读路径：最新在前、covered 行不缺席、
    /// 条目名回查得到就带上；条目删了名字取不到，回落为 null 而不是错行。
    #[test]
    fn the_notify_log_reads_back_everything_including_covered_rows() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll = crate::db::collection_id(&conn, "subs");
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

    /// 任一业务表缺了 ok 都必须翻假（状态码随之 503）：`notification_log` 读不出时每轮提醒
    /// 都在开头失败，健康检查不数它的话容器照样 healthy。
    #[test]
    fn health_reports_false_when_any_business_table_cannot_be_read() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let (ok, payload) = health_payload(&conn);
        assert!(ok);
        assert!(payload["counts"]["items"].as_i64().unwrap() >= 0);

        for table in ["collections", "items", "fields", "renewal_ledger", "notification_log", "settings"] {
            let conn = crate::db::fresh_in_memory().unwrap();
            conn.execute_batch(&format!("PRAGMA foreign_keys = OFF; DROP TABLE {table}")).unwrap();
            let (ok, payload) = health_payload(&conn);
            assert!(!ok, "缺了 {table} 还报健康就是骗探针");
            assert_eq!(payload["ok"], json!(false));
            assert_eq!(payload["counts"][table], json!(-1), "{table}");
        }
    }

    /// 计数要读表本体：`count(*)` 默认走覆盖索引，表页坏了、索引完好时照样数得出来，
    /// 首页与条目列表已经 500，健康检查还回 200。
    #[test]
    fn health_reads_the_table_pages_not_just_a_covering_index() {
        use std::io::{Seek, SeekFrom, Write};
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        let root: u64 = conn
            .query_row("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='items'", [], |r| r.get(0))
            .unwrap();
        let page: u64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        drop(conn);

        let path = dir.path().join("kalends.db");
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start((root - 1) * page)).unwrap();
        f.write_all(&vec![0; usize::try_from(page).unwrap()]).unwrap();
        drop(f);

        let conn = rusqlite::Connection::open(&path).unwrap();
        let (ok, payload) = health_payload(&conn);
        assert!(!ok, "items 表页坏了还报健康：{payload}");
        assert_eq!(payload["counts"]["items"], json!(-1));
    }

    /// 数据目录里的文件名只放行字母数字与 `. _ -`：`/logos/{name}` 与删文件都拼路径，
    /// 放行分隔符或 `..` 就是一次任意文件读 / 删。
    #[test]
    fn safe_name_admits_plain_file_names_only() {
        for ok in ["item-12-1700000000.png", "a.b_c-d", "X"] {
            assert!(safe_name(ok), "{ok}");
        }
        for no in ["", "../x.png", "a/b.png", "a\\b.png", "a b.png", "图.png", "a:b", "a\0"] {
            assert!(!safe_name(no), "{no:?} 不该放行");
        }
    }

    /// 读侧的 extra 文本：解析得出对象才用，空、坏 JSON、非对象一律给 `{}`，
    /// 别让一行坏数据把整张表的读取带崩。
    #[test]
    fn extra_json_reads_anything_but_an_object_as_empty() {
        assert_eq!(extra_json(Some(r#"{"a":"甲"}"#.into())), json!({ "a": "甲" }));
        assert_eq!(extra_json(None), json!({}));
        assert_eq!(extra_json(Some(String::new())), json!({}));
        assert_eq!(extra_json(Some("不是 JSON".into())), json!({}));
        assert_eq!(extra_json(Some("[1,2]".into())), json!({}));
        assert_eq!(extra_json(Some("\"串\"".into())), json!({}));
    }

    async fn body_of(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    /// 容器探针与监控只看状态码：表读不出来必须 503，不能 200 + ok:false。
    #[tokio::test]
    async fn the_health_endpoint_turns_503_when_a_table_is_gone() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;
        let app = App::for_tests(crate::db::fresh_in_memory().unwrap(), std::path::Path::new("."));
        let router = core_router().with_state(app.clone());
        let get = || Request::get("/api/health").body(Body::empty()).unwrap();
        let resp = router.clone().oneshot(get()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_of(resp).await["ok"], json!(true));
        app.db.lock().unwrap().execute_batch("DROP TABLE items").unwrap();
        let resp = router.oneshot(get()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body_of(resp).await["ok"], json!(false));
    }

    /// `/calendar.ics` 自带令牌：没带、带错都是 401；带对了给 `text/calendar` 的日历。
    /// 门在这一层而不在 PIN 网关（日历客户端不会带 PIN）。
    #[tokio::test]
    async fn the_calendar_feed_opens_only_to_the_right_token() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;
        let conn = crate::db::fresh_in_memory().unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('ics.token','abc123')", []).unwrap();
        let router = renewals_router().with_state(App::for_tests(conn, std::path::Path::new(".")));
        let get = |p: &str| Request::get(p).body(Body::empty()).unwrap();
        for denied in ["/calendar.ics", "/calendar.ics?token=", "/calendar.ics?token=abc124"] {
            let resp = router.clone().oneshot(get(denied)).await.unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{denied}");
        }
        let resp = router.oneshot(get("/calendar.ics?token=abc123")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
            Some("text/calendar; charset=utf-8")
        );
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert!(body.starts_with(b"BEGIN:VCALENDAR\r\n"), "{}", String::from_utf8_lossy(&body));
    }

    /// 请求本身的问题是 400 且带可读的 `error`：调用方要能看懂被拒的理由，
    /// 而不是一个空串或一个 500。
    #[tokio::test]
    async fn a_client_error_is_a_400_carrying_its_reason() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;
        let router = core_router().with_state(App::for_tests(crate::db::fresh_in_memory().unwrap(), std::path::Path::new(".")));
        let req = Request::put("/api/settings")
            .header("content-type", "application/json")
            .body(Body::from("[1,2]"))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_of(resp).await["error"], json!("需要对象"));
    }
}
