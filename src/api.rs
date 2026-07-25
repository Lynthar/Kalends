use std::collections::HashMap;

use anyhow::anyhow;
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::NaiveDate;
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
        .route("/api/subscriptions", get(subs_list).post(subs_create))
        .route("/api/subscriptions/{id}", axum::routing::put(subs_update).delete(subs_delete))
        .route("/api/subscriptions/{id}/renew", post(subs_renew))
        .route("/api/sims", get(sims_list).post(sims_create))
        .route("/api/sims/{id}", axum::routing::put(sims_update).delete(sims_delete))
        .route("/api/sims/{id}/renew", post(sims_renew))
        .route("/api/vps", get(vps_list).post(vps_create))
        .route("/api/vps/{id}", axum::routing::put(vps_update).delete(vps_delete))
        .route("/api/vps/{id}/renew", post(vps_renew))
        .route("/api/ledger", get(ledger_list))
        .route("/api/notify/test", post(notify_test))
        .route("/calendar.ics", get(calendar))
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
            "subscriptions": count("subscriptions"),
            "sim_cards": count("sim_cards"),
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
    })))
}

const SUB_COLS: &str = "id,name,parent_id,category,status,price,currency,cycle,cycle_days,next_renewal,payment_method,account,url,notes,created_at,updated_at";

fn sub_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "name": r.get::<_, String>(1)?,
        "parent_id": r.get::<_, Option<i64>>(2)?,
        "category": r.get::<_, Option<String>>(3)?,
        "status": r.get::<_, String>(4)?,
        "price": r.get::<_, Option<f64>>(5)?,
        "currency": r.get::<_, Option<String>>(6)?,
        "cycle": r.get::<_, Option<String>>(7)?,
        "cycle_days": r.get::<_, Option<i64>>(8)?,
        "next_renewal": r.get::<_, Option<String>>(9)?,
        "payment_method": r.get::<_, Option<String>>(10)?,
        "account": r.get::<_, Option<String>>(11)?,
        "url": r.get::<_, Option<String>>(12)?,
        "notes": r.get::<_, Option<String>>(13)?,
        "created_at": r.get::<_, String>(14)?,
        "updated_at": r.get::<_, String>(15)?,
    }))
}

async fn subs_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUB_COLS} FROM subscriptions ORDER BY name COLLATE NOCASE"
    ))?;
    let rows: Vec<Value> = stmt
        .query_map([], sub_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Json(json!(rows)))
}

async fn subs_create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let name = s(&b, "name").ok_or_else(|| anyhow!("名称不能为空"))?;
    conn.execute(
        "INSERT INTO subscriptions(name,parent_id,category,status,price,currency,cycle,cycle_days,next_renewal,payment_method,account,url,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            name,
            i(&b, "parent_id"),
            s(&b, "category"),
            s(&b, "status").unwrap_or_else(|| "Planned".into()),
            f(&b, "price"),
            s(&b, "currency"),
            s(&b, "cycle"),
            i(&b, "cycle_days"),
            s(&b, "next_renewal"),
            s(&b, "payment_method"),
            s(&b, "account"),
            s(&b, "url"),
            s(&b, "notes"),
        ],
    )?;
    let id = conn.last_insert_rowid();
    if let (Some(p), Some(c)) = (f(&b, "price"), s(&b, "currency")) {
        conn.execute(
            "INSERT INTO price_history(subscription_id,price,currency,effective_from) VALUES(?1,?2,?3,?4)",
            params![id, p, c, engine::today().to_string()],
        )?;
    }
    Ok(Json(json!({ "id": id })))
}

async fn subs_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let old: Option<(Option<f64>, Option<String>)> = conn
        .query_row(
            "SELECT price,currency FROM subscriptions WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((old_price, old_currency)) = old else {
        return Err(anyhow!("条目不存在").into());
    };
    conn.execute(
        "UPDATE subscriptions SET name=?1,parent_id=?2,category=?3,status=?4,price=?5,currency=?6,cycle=?7,cycle_days=?8,next_renewal=?9,payment_method=?10,account=?11,url=?12,notes=?13,updated_at=datetime('now') WHERE id=?14",
        params![
            s(&b, "name").ok_or_else(|| anyhow!("名称不能为空"))?,
            i(&b, "parent_id"),
            s(&b, "category"),
            s(&b, "status").unwrap_or_else(|| "Planned".into()),
            f(&b, "price"),
            s(&b, "currency"),
            s(&b, "cycle"),
            i(&b, "cycle_days"),
            s(&b, "next_renewal"),
            s(&b, "payment_method"),
            s(&b, "account"),
            s(&b, "url"),
            s(&b, "notes"),
            id,
        ],
    )?;
    // 价格或币种变化 → 自动记入涨价历史
    let (np, nc) = (f(&b, "price"), s(&b, "currency"));
    if let (Some(p), Some(c)) = (np, nc.clone()) {
        if old_price != Some(p) || old_currency != Some(c.clone()) {
            conn.execute(
                "INSERT INTO price_history(subscription_id,price,currency,effective_from) VALUES(?1,?2,?3,?4)",
                params![id, p, c, engine::today().to_string()],
            )?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

async fn subs_delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let conn = app.db.lock().unwrap();
    conn.execute("DELETE FROM subscriptions WHERE id=?1", [id])?;
    Ok(Json(json!({ "ok": true })))
}

async fn subs_renew(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let row: Option<(Option<f64>, Option<String>, Option<String>, Option<i64>, Option<String>)> =
        conn.query_row(
            "SELECT price,currency,cycle,cycle_days,next_renewal FROM subscriptions WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    let Some((price, currency, cycle, cycle_days, next)) = row else {
        return Err(anyhow!("条目不存在").into());
    };
    let today = engine::today();
    conn.execute(
        "INSERT INTO renewal_ledger(kind,item_id,renewed_at,amount,currency,note)
         VALUES('subscription',?1,?2,?3,?4,?5)",
        params![
            id,
            today.to_string(),
            f(&b, "amount").or(price),
            s(&b, "currency").or(currency),
            s(&b, "note"),
        ],
    )?;
    let mut new_next: Option<String> = None;
    if let (Some(cy), Some(nx)) = (cycle.as_deref(), next.as_deref()) {
        if let Ok(start) = NaiveDate::parse_from_str(nx, "%Y-%m-%d") {
            if let Some(mut d) = engine::advance(start, cy, cycle_days) {
                while d <= today {
                    match engine::advance(d, cy, cycle_days) {
                        Some(n) => d = n,
                        None => break,
                    }
                }
                new_next = Some(d.to_string());
            }
        }
    }
    if let Some(n) = &new_next {
        conn.execute(
            "UPDATE subscriptions SET next_renewal=?1,updated_at=datetime('now') WHERE id=?2",
            params![n, id],
        )?;
    }
    Ok(Json(json!({ "next_renewal": new_next })))
}

const SIM_COLS: &str =
    "id,name,phone_number,forms,status,keepalive_action,cycle_days,last_renewed,notes,created_at,updated_at";

fn sim_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let forms: Option<String> = r.get(3)?;
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "name": r.get::<_, String>(1)?,
        "phone_number": r.get::<_, Option<String>>(2)?,
        "forms": forms
            .and_then(|x| serde_json::from_str::<Value>(&x).ok())
            .unwrap_or_else(|| json!([])),
        "status": r.get::<_, String>(4)?,
        "keepalive_action": r.get::<_, Option<String>>(5)?,
        "cycle_days": r.get::<_, Option<i64>>(6)?,
        "last_renewed": r.get::<_, Option<String>>(7)?,
        "notes": r.get::<_, Option<String>>(8)?,
        "created_at": r.get::<_, String>(9)?,
        "updated_at": r.get::<_, String>(10)?,
    }))
}

async fn sims_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SIM_COLS} FROM sim_cards ORDER BY name COLLATE NOCASE"
    ))?;
    let rows: Vec<Value> = stmt
        .query_map([], sim_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Json(json!(rows)))
}

fn forms_str(b: &Value) -> Option<String> {
    b.get("forms")
        .filter(|x| x.is_array())
        .map(|x| x.to_string())
}

async fn sims_create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    conn.execute(
        "INSERT INTO sim_cards(name,phone_number,forms,status,keepalive_action,cycle_days,last_renewed,notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            s(&b, "name").ok_or_else(|| anyhow!("名称不能为空"))?,
            s(&b, "phone_number"),
            forms_str(&b),
            s(&b, "status").unwrap_or_else(|| "未启用".into()),
            s(&b, "keepalive_action"),
            i(&b, "cycle_days"),
            s(&b, "last_renewed"),
            s(&b, "notes"),
        ],
    )?;
    Ok(Json(json!({ "id": conn.last_insert_rowid() })))
}

async fn sims_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let n = conn.execute(
        "UPDATE sim_cards SET name=?1,phone_number=?2,forms=?3,status=?4,keepalive_action=?5,cycle_days=?6,last_renewed=?7,notes=?8,updated_at=datetime('now') WHERE id=?9",
        params![
            s(&b, "name").ok_or_else(|| anyhow!("名称不能为空"))?,
            s(&b, "phone_number"),
            forms_str(&b),
            s(&b, "status").unwrap_or_else(|| "未启用".into()),
            s(&b, "keepalive_action"),
            i(&b, "cycle_days"),
            s(&b, "last_renewed"),
            s(&b, "notes"),
            id,
        ],
    )?;
    if n == 0 {
        return Err(anyhow!("条目不存在").into());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn sims_delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let conn = app.db.lock().unwrap();
    conn.execute("DELETE FROM sim_cards WHERE id=?1", [id])?;
    Ok(Json(json!({ "ok": true })))
}

async fn sims_renew(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let today = engine::today().to_string();
    let n = conn.execute(
        "UPDATE sim_cards SET last_renewed=?1,updated_at=datetime('now') WHERE id=?2",
        params![today, id],
    )?;
    if n == 0 {
        return Err(anyhow!("条目不存在").into());
    }
    conn.execute(
        "INSERT INTO renewal_ledger(kind,item_id,renewed_at,amount,currency,note)
         VALUES('sim',?1,?2,?3,?4,?5)",
        params![id, today, f(&b, "amount"), s(&b, "currency"), s(&b, "note")],
    )?;
    Ok(Json(json!({ "last_renewed": today })))
}

const VPS_STR: &[&str] = &[
    "vendor", "product", "status", "purpose", "storage_type", "extra_storage",
    "currency", "cycle", "last_renewed", "url", "account", "notes",
];
const VPS_INT: &[&str] = &["cycle_days", "ipv6"];
const VPS_REAL: &[&str] = &["cores", "ram_gb", "storage_gb", "port_gbps", "traffic_tb", "price"];
const VPS_ARR: &[&str] = &["locations", "routes"];

fn vps_values(b: &Value) -> (Vec<&'static str>, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value as V;
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for k in VPS_STR {
        cols.push(*k);
        vals.push(s(b, k).map(V::from).unwrap_or(V::Null));
    }
    for k in VPS_INT {
        cols.push(*k);
        let v = i(b, k).or_else(|| b.get(*k).and_then(|x| x.as_bool()).map(i64::from));
        vals.push(v.map(V::from).unwrap_or(V::Null));
    }
    for k in VPS_REAL {
        cols.push(*k);
        vals.push(f(b, k).map(V::from).unwrap_or(V::Null));
    }
    for k in VPS_ARR {
        cols.push(*k);
        let v = b.get(*k).filter(|x| x.is_array()).map(|x| x.to_string());
        vals.push(v.map(V::from).unwrap_or(V::Null));
    }
    (cols, vals)
}

fn vps_row(r: &rusqlite::Row, cols: &[String]) -> rusqlite::Result<Value> {
    let mut obj = serde_json::Map::new();
    for (idx, c) in cols.iter().enumerate() {
        let v = match r.get_ref(idx)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(n) => Value::from(n),
            rusqlite::types::ValueRef::Real(x) => Value::from(x),
            rusqlite::types::ValueRef::Text(t) => {
                let text = String::from_utf8_lossy(t).into_owned();
                if VPS_ARR.contains(&c.as_str()) {
                    serde_json::from_str(&text).unwrap_or(Value::from(text))
                } else {
                    Value::from(text)
                }
            }
            rusqlite::types::ValueRef::Blob(_) => Value::Null,
        };
        obj.insert(c.clone(), v);
    }
    Ok(Value::Object(obj))
}

async fn vps_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT * FROM vps_instances ORDER BY vendor COLLATE NOCASE, id")?;
    let cols: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let rows: Vec<Value> = stmt
        .query_map([], |r| vps_row(r, &cols))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Json(json!(rows)))
}

async fn vps_create(State(app): State<App>, Json(b): Json<Value>) -> R {
    if s(&b, "vendor").is_none() {
        return Err(anyhow!("商家不能为空").into());
    }
    let conn = app.db.lock().unwrap();
    let (cols, vals) = vps_values(&b);
    let placeholders: Vec<String> = (1..=cols.len()).map(|n| format!("?{n}")).collect();
    conn.execute(
        &format!(
            "INSERT INTO vps_instances({}) VALUES({})",
            cols.join(","),
            placeholders.join(",")
        ),
        rusqlite::params_from_iter(vals),
    )?;
    Ok(Json(json!({ "id": conn.last_insert_rowid() })))
}

async fn vps_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    if s(&b, "vendor").is_none() {
        return Err(anyhow!("商家不能为空").into());
    }
    let conn = app.db.lock().unwrap();
    let (cols, mut vals) = vps_values(&b);
    let sets: Vec<String> = cols
        .iter()
        .enumerate()
        .map(|(idx, c)| format!("{c}=?{}", idx + 1))
        .collect();
    vals.push(rusqlite::types::Value::from(id));
    let n = conn.execute(
        &format!(
            "UPDATE vps_instances SET {},updated_at=datetime('now') WHERE id=?{}",
            sets.join(","),
            cols.len() + 1
        ),
        rusqlite::params_from_iter(vals),
    )?;
    if n == 0 {
        return Err(anyhow!("条目不存在").into());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn vps_delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let conn = app.db.lock().unwrap();
    conn.execute("DELETE FROM vps_instances WHERE id=?1", [id])?;
    Ok(Json(json!({ "ok": true })))
}

async fn vps_renew(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let row: Option<(Option<f64>, Option<String>)> = conn
        .query_row(
            "SELECT price,currency FROM vps_instances WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((price, currency)) = row else {
        return Err(anyhow!("条目不存在").into());
    };
    let today = engine::today().to_string();
    conn.execute(
        "UPDATE vps_instances SET last_renewed=?1,updated_at=datetime('now') WHERE id=?2",
        params![today, id],
    )?;
    conn.execute(
        "INSERT INTO renewal_ledger(kind,item_id,renewed_at,amount,currency,note)
         VALUES('vps',?1,?2,?3,?4,?5)",
        params![
            id,
            today,
            f(&b, "amount").or(price),
            s(&b, "currency").or(currency),
            s(&b, "note"),
        ],
    )?;
    Ok(Json(json!({ "last_renewed": today })))
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
