//! 旧端点适配层（临时）：/api/subscriptions、/api/sims、/api/vps 仍按原来的形状收发，
//! 底下已经是 collections + items。域字段在 extra 里，这里读时摊平回顶层、写时收回 extra。
//!
//! 存在的唯一理由是让既有前端与那套端到端断言在库泛化落地时保持可用；
//! 前端改成按库驱动之后，这个文件连同这几条路由一起删掉。

use anyhow::anyhow;
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::api::{s, R};
use crate::collections::{
    clear_logo, delete_item, insert_item, items_of, renew_item, set_logo, update_item,
};
use crate::App;

/// 三个内置库里、旧接口暴露在顶层而实际存 extra 的域字段。
const SUBS_X: &[&str] = &["category", "payment_method", "account"];
const SIMS_X: &[&str] = &["phone_number", "forms", "keepalive_action"];
const VPS_X: &[&str] = &[
    "product", "purpose", "locations", "routes", "cores", "ram_gb", "storage_gb",
    "storage_type", "extra_storage", "port_gbps", "traffic_tb", "ipv6", "account",
];

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/subscriptions", get(subs_list).post(subs_create))
        .route(
            "/api/subscriptions/{id}",
            axum::routing::put(subs_update).delete(item_delete),
        )
        .route("/api/subscriptions/{id}/renew", post(item_renew))
        .route(
            "/api/subscriptions/{id}/logo",
            post(item_logo_set).delete(item_logo_clear),
        )
        .route("/api/sims", get(sims_list).post(sims_create))
        .route(
            "/api/sims/{id}",
            axum::routing::put(sims_update).delete(item_delete),
        )
        .route("/api/sims/{id}/renew", post(item_renew))
        .route("/api/vps", get(vps_list).post(vps_create))
        .route(
            "/api/vps/{id}",
            axum::routing::put(vps_update).delete(item_delete),
        )
        .route("/api/vps/{id}/renew", post(item_renew))
}

/// 通用条目 → 旧形状：挑出引擎字段，把 keys 指定的域字段从 extra 提到顶层，其余 extra 原样留着
/// （自定义列的值就在里面，前端仍按 extra[c<id>] 读）。
fn flatten(it: &Value, keys: &[&str], engine_keys: &[&str], rename_name: Option<&str>) -> Value {
    let mut o = Map::new();
    for k in engine_keys {
        o.insert((*k).to_string(), it[*k].clone());
    }
    if let Some(alias) = rename_name {
        o.insert(alias.to_string(), it["name"].clone());
    } else {
        o.insert("name".into(), it["name"].clone());
    }
    let mut extra = it["extra"].as_object().cloned().unwrap_or_default();
    for k in keys {
        let v = extra.remove(*k).unwrap_or(Value::Null);
        o.insert((*k).to_string(), v);
    }
    o.insert("extra".into(), Value::Object(extra));
    Value::Object(o)
}

/// 旧形状 → 通用条目：把顶层域字段收回 extra，其余照原样传给通用写入。
fn fold(b: &Value, keys: &[&str], rename_name: Option<&str>) -> Value {
    let mut o = b.as_object().cloned().unwrap_or_default();
    let mut extra = o
        .remove("extra")
        .and_then(|x| x.as_object().cloned())
        .unwrap_or_default();
    for k in keys {
        match o.remove(*k) {
            Some(Value::Null) | None => {
                extra.remove(*k);
            }
            // 空串按"清空"处理，与整行 PUT 的全量替换语义一致
            Some(Value::String(s)) if s.is_empty() => {
                extra.remove(*k);
            }
            Some(v) => {
                extra.insert((*k).to_string(), v);
            }
        }
    }
    if let Some(alias) = rename_name {
        if let Some(v) = o.remove(alias) {
            o.insert("name".into(), v);
        }
    }
    o.insert("extra".into(), Value::Object(extra));
    Value::Object(o)
}

const SUB_ENGINE: &[&str] = &[
    "id", "parent_id", "status", "price", "currency", "cycle", "cycle_days",
    "next_renewal", "url", "notes", "logo", "created_at", "updated_at",
];
const SIM_ENGINE: &[&str] = &[
    "id", "status", "cycle_days", "last_renewed", "notes", "created_at", "updated_at",
];
const VPS_ENGINE: &[&str] = &[
    "id", "status", "price", "currency", "cycle", "cycle_days", "last_renewed",
    "url", "notes", "created_at", "updated_at",
];

/// 旧接口按名称排序（COLLATE NOCASE），这里照旧。
fn sorted(mut rows: Vec<Value>, key: &str) -> Vec<Value> {
    rows.sort_by(|a, b| {
        let ka = a[key].as_str().unwrap_or("").to_lowercase();
        let kb = b[key].as_str().unwrap_or("").to_lowercase();
        ka.cmp(&kb).then(a["id"].as_i64().cmp(&b["id"].as_i64()))
    });
    rows
}

async fn subs_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let rows = items_of(&conn, "subs")?
        .iter()
        .map(|it| flatten(it, SUBS_X, SUB_ENGINE, None))
        .collect();
    Ok(Json(json!(sorted(rows, "name"))))
}

async fn sims_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let rows: Vec<Value> = items_of(&conn, "sims")?
        .iter()
        .map(|it| {
            let mut o = flatten(it, SIMS_X, SIM_ENGINE, None);
            // 旧接口的形式列恒为数组
            if !o["forms"].is_array() {
                o["forms"] = json!([]);
            }
            o
        })
        .collect();
    Ok(Json(json!(sorted(rows, "name"))))
}

async fn vps_list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let rows: Vec<Value> = items_of(&conn, "vps")?
        .iter()
        .map(|it| flatten(it, VPS_X, VPS_ENGINE, Some("vendor")))
        .collect();
    Ok(Json(json!(sorted(rows, "vendor"))))
}

async fn subs_create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let id = insert_item(&conn, coll(&conn, "subs")?, &fold(&b, SUBS_X, None))?;
    Ok(Json(json!({ "id": id })))
}

async fn sims_create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let body = with_days_cycle(fold(&b, SIMS_X, None));
    let id = insert_item(&conn, coll(&conn, "sims")?, &body)?;
    Ok(Json(json!({ "id": id })))
}

async fn vps_create(State(app): State<App>, Json(b): Json<Value>) -> R {
    if s(&b, "vendor").is_none() {
        return Err(anyhow!("商家不能为空").into());
    }
    let conn = app.db.lock().unwrap();
    let id = insert_item(&conn, coll(&conn, "vps")?, &fold(&b, VPS_X, Some("vendor")))?;
    Ok(Json(json!({ "id": id })))
}

async fn subs_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    update_item(&conn, id, &fold(&b, SUBS_X, None))?;
    Ok(Json(json!({ "ok": true })))
}

async fn sims_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    update_item(&conn, id, &with_days_cycle(fold(&b, SIMS_X, None)))?;
    Ok(Json(json!({ "ok": true })))
}

async fn vps_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    if s(&b, "vendor").is_none() {
        return Err(anyhow!("商家不能为空").into());
    }
    let conn = app.db.lock().unwrap();
    update_item(&conn, id, &fold(&b, VPS_X, Some("vendor")))?;
    Ok(Json(json!({ "ok": true })))
}

/// SIM 旧接口只传保号天数，没有周期字段；补上 cycle='days' 才能走通用到期推算。
fn with_days_cycle(mut b: Value) -> Value {
    let days = b["cycle_days"].as_i64().unwrap_or(0);
    b["cycle"] = if days > 0 { json!("days") } else { Value::Null };
    b
}

fn coll(conn: &rusqlite::Connection, key: &str) -> anyhow::Result<i64> {
    conn.query_row("SELECT id FROM collections WHERE key=?1", [key], |r| r.get(0))
        .map_err(|_| anyhow!("库不存在：{key}"))
}

async fn item_delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    delete_item(&app2, &conn, id)?;
    Ok(Json(json!({ "ok": true })))
}

async fn item_renew(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(renew_item(&conn, id, &b)?))
}

async fn item_logo_set(
    State(app): State<App>,
    Path(id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> R {
    let ext = q.get("ext").cloned().unwrap_or_default();
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    let name = set_logo(&app2, &conn, id, &ext, &body)?;
    Ok(Json(json!({ "logo": name })))
}

async fn item_logo_clear(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    clear_logo(&app2, &conn, id)?;
    Ok(Json(json!({ "ok": true })))
}
