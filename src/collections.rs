//! 库（collections）与条目（items）：一份通用 CRUD 取代原先订阅 / SIM / VPS 三份同构实现。
//! 引擎要用的字段是 items 的真列，域字段挂在 extra JSON 里（键即字段键），与自定义列同一机制。

use std::collections::HashMap;

use anyhow::anyhow;
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::api::{extra_json, extra_str, f, i, s, ApiError, R};
use crate::{engine, App};

const ANCHORS: &[&str] = &["next", "last"];

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/collections", get(list).post(create))
        .route("/api/collections/templates", get(templates))
        .route("/api/collections/{id}", put(update).delete(remove))
        .route("/api/collections/{key}/items", get(items_list).post(items_create))
        .route("/api/items/{id}", put(items_update).delete(items_delete))
        .route("/api/items/{id}/renew", post(items_renew))
        .route("/api/items/{id}/logo", post(logo_set).delete(logo_clear))
        .route("/logos/{name}", get(logo_file))
}

/* ── 库 ─────────────────────────────────────────────────────────── */

const COLL_COLS: &str =
    "id,key,name,icon,due_anchor,subtitle,subline,verb,note_field,pos,builtin";

fn coll_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "key": r.get::<_, String>(1)?,
        "name": r.get::<_, String>(2)?,
        "icon": r.get::<_, Option<String>>(3)?,
        "due_anchor": r.get::<_, String>(4)?,
        "subtitle": r.get::<_, Option<String>>(5)?,
        "subline": r.get::<_, Option<String>>(6)?,
        "verb": r.get::<_, Option<String>>(7)?,
        "note_field": r.get::<_, Option<String>>(8)?,
        "pos": r.get::<_, i64>(9)?,
        "builtin": r.get::<_, i64>(10)? != 0,
    }))
}

pub fn collections(conn: &Connection) -> anyhow::Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLL_COLS} FROM collections ORDER BY pos, id"
    ))?;
    let rows: Vec<Value> = stmt.query_map([], coll_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

async fn list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!(collections(&conn)?)))
}

/// 库 id：按 key 找。找不到就是 404 级错误，交给调用方兜。
fn coll_id(conn: &Connection, key: &str) -> anyhow::Result<i64> {
    conn.query_row("SELECT id FROM collections WHERE key=?1", [key], |r| r.get(0))
        .map_err(|_| anyhow!("库不存在：{key}"))
}

fn anchor_of(conn: &Connection, id: i64) -> anyhow::Result<String> {
    Ok(conn.query_row(
        "SELECT due_anchor FROM collections WHERE id=?1",
        [id],
        |r| r.get(0),
    )?)
}

async fn create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tpl = match s(&b, "template") {
        Some(id) => Some(template(&id).ok_or_else(|| anyhow!("未知模板：{id}"))?),
        None => None,
    };
    let name = s(&b, "name").ok_or_else(|| anyhow!("库名不能为空"))?;
    let anchor = s(&b, "due_anchor")
        .or_else(|| tpl.map(|t| t.anchor.to_string()))
        .unwrap_or_else(|| "last".into());
    if !ANCHORS.contains(&anchor.as_str()) {
        return Err(anyhow!("未知的到期模型：{anchor}").into());
    }
    let opt = |x: &'static str| (!x.is_empty()).then(|| x.to_string());
    // 模板只在调用方压根没提这个键时兜底：界面清空图标传的是 ""，不该被模板值顶回来
    let take = |k: &str, dflt: Option<String>| -> Option<String> {
        if b.get(k).is_some() { s(&b, k) } else { dflt }
    };
    let conn = app.db.lock().unwrap();
    let pos: i64 = conn.query_row("SELECT coalesce(max(pos),0)+1 FROM collections", [], |r| {
        r.get(0)
    })?;
    // key 由 id 派生，避免用户起名撞上内置键或包含路径字符
    conn.execute(
        "INSERT INTO collections(key,name,icon,due_anchor,subtitle,subline,verb,note_field,pos,builtin)
         VALUES('',?1,?2,?3,NULL,?4,?5,NULL,?6,0)",
        params![
            name,
            take("icon", tpl.and_then(|t| opt(t.icon))),
            anchor,
            tpl.and_then(|t| opt(t.subline)),
            take("verb", tpl.and_then(|t| opt(t.verb))),
            pos
        ],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute("UPDATE collections SET key='k'||id WHERE id=?1", [id])?;
    let key: String = conn.query_row("SELECT key FROM collections WHERE id=?1", [id], |r| r.get(0))?;
    seed_fields(&conn, &key, &anchor, tpl)?;
    let row = conn.query_row(
        &format!("SELECT {COLL_COLS} FROM collections WHERE id=?1"),
        [id],
        coll_row,
    )?;
    Ok(Json(row))
}

/* ── 建库模板：一套预置字段集 + 库属性，免得新建的库是个空壳 ────────── */

/// 模板只决定"库刚建好时长什么样"，落表后就是普通字段——域字段与用户手加的
/// 自定义列同权（`builtin=0`），可改名、可改选项、可删。
struct Template {
    id: &'static str,
    label: &'static str,
    icon: &'static str,
    desc: &'static str,
    anchor: &'static str,
    verb: &'static str,
    /// 名称格下方小字取哪个字段（不进日历标题，那是 subtitle）
    subline: &'static str,
    /// 对通用字段的调整：(字段键, 显示名；空=沿用默认, 是否默认上表)
    base: &'static [(&'static str, &'static str, i64)],
    /// 域字段，值挂 items.extra：(字段键, 显示名, 类型, 是否默认上表, 预置选项；逗号分隔)
    extra: &'static [(&'static str, &'static str, &'static str, i64, &'static str)],
}

/// 第一项必须是空白模板：前端的模板选择器默认选它。
/// 预置选项只给真正封闭的词表；注册商、保险公司这类开放词表留空，让它从数据里长出来。
const TEMPLATES: &[Template] = &[
    Template {
        id: "blank",
        label: "空白",
        icon: "",
        desc: "只有通用字段，列自己加",
        anchor: "last",
        verb: "",
        subline: "",
        base: &[],
        extra: &[],
    },
    Template {
        id: "domain",
        label: "域名",
        icon: "🌐",
        desc: "域名注册与到期",
        anchor: "next",
        verb: "续费",
        subline: "",
        base: &[("next_renewal", "到期日", 1)],
        extra: &[
            ("registrar", "注册商", "sel", 1, ""),
            ("auto_renew", "自动续费", "sel", 1, "开,关"),
            ("dns", "DNS 托管", "sel", 0, ""),
            ("usage", "用途", "sel", 0, ""),
        ],
    },
    Template {
        id: "insurance",
        label: "保险",
        icon: "🛡️",
        desc: "保单与续保日",
        anchor: "next",
        verb: "续保",
        subline: "policy_no",
        base: &[("next_renewal", "保单到期", 1)],
        extra: &[
            ("insurer", "保险公司", "sel", 1, ""),
            ("policy_type", "险种", "sel", 1, "医疗,重疾,意外,寿险,车险,财产,旅行"),
            ("insured", "被保险人", "text", 1, ""),
            ("coverage", "保额", "num", 0, ""),
            ("policy_no", "保单号", "text", 0, ""),
        ],
    },
    Template {
        id: "docs",
        label: "证件",
        icon: "🪪",
        desc: "护照签证等有效期",
        anchor: "next",
        verb: "换证",
        subline: "",
        // 证件多半没有周期费用：费用/币种/周期退进详情表单，不占表格列位
        base: &[
            ("next_renewal", "有效期至", 1),
            ("price", "工本费", 0),
            ("currency", "", 0),
            ("cycle", "", 0),
        ],
        extra: &[
            ("doc_type", "证件类型", "sel", 1, "护照,身份证,驾照,签证,居留许可,通行证"),
            ("holder", "持有人", "text", 1, ""),
            ("doc_no", "证件号码", "text", 0, ""),
            ("issuer", "签发机关", "text", 0, ""),
        ],
    },
];

fn template(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
}

async fn templates() -> R {
    let out: Vec<Value> = TEMPLATES
        .iter()
        .map(|t| {
            json!({
                "id": t.id,
                "label": t.label,
                "icon": t.icon,
                "desc": t.desc,
                "due_anchor": t.anchor,
                "verb": t.verb,
                // 域字段的显示名，供选择器预览；含只进详情表单（shown=0）的那些
                "fields": t.extra.iter().map(|(_, n, ..)| *n).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

/// 新建的库要能直接用：播一套默认字段集，否则表格没有列、详情表单是空的。
/// 到期锚点决定给"下次到期日"还是"上次续费 + 剩余天数"，模板再往上加域字段。
const STATUS_VOCAB: &str = r#"[{"v":"Active","spend":1,"alert":1,"timeline":1},
  {"v":"Planned","spend":0,"alert":0,"timeline":0},
  {"v":"Ending","spend":0,"alert":0,"timeline":1},
  {"v":"Ended","spend":0,"alert":0,"timeline":0}]"#;

fn seed_fields(
    conn: &Connection,
    key: &str,
    anchor: &str,
    tpl: Option<&Template>,
) -> anyhow::Result<()> {
    // (键, 显示名, 类型, 数据源, 默认上表, 序)；序号留了空档，模板的域字段插在 10 段
    let mut defs: Vec<(&str, &str, &str, &str, i64, i64)> = vec![
        ("name", "名称", "text", "col", 1, 1),
        ("status", "状态", "status", "col", 1, 2),
        ("price", "费用", "num", "col", 1, 30),
        ("currency", "币种", "sel", "col", 1, 31),
        ("cycle", "周期", "sel", "col", 1, 32),
    ];
    if anchor == "next" {
        defs.push(("next_renewal", "下次到期", "date", "col", 1, 40));
    } else {
        defs.push(("last_renewed", "上次续费", "date", "col", 1, 40));
        defs.push(("left", "剩余天数", "num", "calc", 1, 41));
    }
    defs.push(("notes", "备注", "text", "col", 1, 50));
    defs.push(("cycle_days", "周期天数", "num", "col", 0, 60));
    defs.push(("url", "链接", "text", "col", 0, 61));
    for (k, name, shown) in tpl.map_or(&[][..], |t| t.base) {
        let Some(d) = defs.iter_mut().find(|d| d.0 == *k) else { continue };
        if !name.is_empty() {
            d.1 = name;
        }
        d.4 = *shown;
    }
    for (k, name, ftype, src, shown, pos) in defs {
        let options = if k == "status" { STATUS_VOCAB } else { "[]" };
        conn.execute(
            "INSERT INTO fields(tbl,key,name,ftype,src,shown,pos,builtin,options)
             VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8)
             ON CONFLICT(tbl,key) DO NOTHING",
            params![key, k, name, ftype, src, shown, pos, options],
        )?;
    }
    for (n, (k, name, ftype, shown, opts)) in tpl.map_or(&[][..], |t| t.extra).iter().enumerate() {
        let options = serde_json::to_string(
            &opts
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| json!({ "v": v }))
                .collect::<Vec<_>>(),
        )?;
        conn.execute(
            "INSERT INTO fields(tbl,key,name,ftype,src,shown,pos,builtin,options)
             VALUES(?1,?2,?3,?4,'extra',?5,?6,0,?7)
             ON CONFLICT(tbl,key) DO NOTHING",
            params![key, k, name, ftype, shown, 10 + n as i64, options],
        )?;
    }
    Ok(())
}

async fn update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let cur = conn
        .query_row(
            &format!("SELECT {COLL_COLS} FROM collections WHERE id=?1"),
            [id],
            coll_row,
        )
        .map_err(|_| anyhow!("库不存在"))?;
    // 逐字段合并：只改传来的键，其余保留
    let pick = |k: &str| -> Option<String> { s(&b, k) };
    let anchor = pick("due_anchor").unwrap_or_else(|| cur["due_anchor"].as_str().unwrap().into());
    if !ANCHORS.contains(&anchor.as_str()) {
        return Err(anyhow!("未知的到期模型：{anchor}").into());
    }
    let name = pick("name").unwrap_or_else(|| cur["name"].as_str().unwrap().into());
    if name.is_empty() {
        return Err(anyhow!("库名不能为空").into());
    }
    let take = |k: &str| -> Option<String> {
        if b.get(k).is_some() {
            pick(k)
        } else {
            cur[k].as_str().map(String::from)
        }
    };
    let pos = i(&b, "pos").unwrap_or_else(|| cur["pos"].as_i64().unwrap());
    conn.execute(
        "UPDATE collections SET name=?1,icon=?2,due_anchor=?3,subtitle=?4,subline=?5,
         verb=?6,note_field=?7,pos=?8 WHERE id=?9",
        params![
            name,
            take("icon"),
            anchor,
            take("subtitle"),
            take("subline"),
            take("verb"),
            take("note_field"),
            pos,
            id
        ],
    )?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    let key: String = conn
        .query_row("SELECT key FROM collections WHERE id=?1", [id], |r| r.get(0))
        .map_err(|_| anyhow!("库不存在"))?;
    // 条目随库走（外键 ON DELETE CASCADE），先把 logo 文件清掉免得留孤儿
    let mut stmt = conn.prepare("SELECT logo FROM items WHERE collection_id=?1 AND logo IS NOT NULL")?;
    let logos: Vec<String> = stmt
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    conn.execute("DELETE FROM collections WHERE id=?1", [id])?;
    conn.execute("DELETE FROM fields WHERE tbl=?1", [&key])?;
    for name in logos {
        remove_logo_file(&app2, Some(name));
    }
    Ok(Json(json!({ "ok": true })))
}

/* ── 条目 ───────────────────────────────────────────────────────── */

const ITEM_COLS: &str = "id,collection_id,name,parent_id,status,price,currency,cycle,cycle_days,\
                         next_renewal,last_renewed,url,notes,logo,extra,created_at,updated_at";

pub fn item_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "collection_id": r.get::<_, i64>(1)?,
        "name": r.get::<_, String>(2)?,
        "parent_id": r.get::<_, Option<i64>>(3)?,
        "status": r.get::<_, String>(4)?,
        "price": r.get::<_, Option<f64>>(5)?,
        "currency": r.get::<_, Option<String>>(6)?,
        "cycle": r.get::<_, Option<String>>(7)?,
        "cycle_days": r.get::<_, Option<i64>>(8)?,
        "next_renewal": r.get::<_, Option<String>>(9)?,
        "last_renewed": r.get::<_, Option<String>>(10)?,
        "url": r.get::<_, Option<String>>(11)?,
        "notes": r.get::<_, Option<String>>(12)?,
        "logo": r.get::<_, Option<String>>(13)?,
        "extra": extra_json(r.get::<_, Option<String>>(14)?),
        "created_at": r.get::<_, String>(15)?,
        "updated_at": r.get::<_, String>(16)?,
    }))
}

/// 一个库里的条目；带上按库到期模型算出的到期日与剩余天数。
pub fn items_of(conn: &Connection, key: &str) -> anyhow::Result<Vec<Value>> {
    let id = coll_id(conn, key)?;
    let anchor = anchor_of(conn, id)?;
    let mut stmt =
        conn.prepare(&format!("SELECT {ITEM_COLS} FROM items WHERE collection_id=?1 ORDER BY id"))?;
    let mut rows: Vec<Value> = stmt
        .query_map([id], item_row)?
        .collect::<rusqlite::Result<_>>()?;
    let today = engine::today();
    for r in rows.iter_mut() {
        let due = due_of(r, &anchor);
        r["due"] = json!(due.map(|d| d.to_string()));
        r["days_left"] = json!(due.map(|d| (d - today).num_days()));
    }
    Ok(rows)
}

/// 到期日：due_anchor='next' 直接读下次续费日，否则从上次续费按周期推一步。
pub fn due_of(r: &Value, anchor: &str) -> Option<NaiveDate> {
    let cycle = r["cycle"].as_str().unwrap_or("");
    if cycle == "lifetime" {
        return None;
    }
    if anchor == "next" {
        return NaiveDate::parse_from_str(r["next_renewal"].as_str()?, "%Y-%m-%d").ok();
    }
    let last = NaiveDate::parse_from_str(r["last_renewed"].as_str()?, "%Y-%m-%d").ok()?;
    engine::advance(last, cycle, r["cycle_days"].as_i64())
}

async fn items_list(State(app): State<App>, Path(key): Path<String>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!(items_of(&conn, &key)?)))
}

/// 写入用的字段集：整行 PUT 语义是全量替换，没传的键一律置空。
fn item_values(b: &Value) -> anyhow::Result<Vec<rusqlite::types::Value>> {
    use rusqlite::types::Value as V;
    let name = s(b, "name").ok_or_else(|| anyhow!("名称不能为空"))?;
    Ok(vec![
        V::from(name),
        i(b, "parent_id").map(V::from).unwrap_or(V::Null),
        V::from(s(b, "status").unwrap_or_else(|| "Planned".into())),
        f(b, "price").map(V::from).unwrap_or(V::Null),
        s(b, "currency").map(V::from).unwrap_or(V::Null),
        s(b, "cycle").map(V::from).unwrap_or(V::Null),
        i(b, "cycle_days").map(V::from).unwrap_or(V::Null),
        s(b, "next_renewal").map(V::from).unwrap_or(V::Null),
        s(b, "last_renewed").map(V::from).unwrap_or(V::Null),
        s(b, "url").map(V::from).unwrap_or(V::Null),
        s(b, "notes").map(V::from).unwrap_or(V::Null),
        s(b, "logo").map(V::from).unwrap_or(V::Null),
        extra_str(b).map(V::from).unwrap_or(V::Null),
    ])
}

const WRITE_COLS: &str = "name,parent_id,status,price,currency,cycle,cycle_days,\
                          next_renewal,last_renewed,url,notes,logo,extra";

pub fn insert_item(conn: &Connection, coll: i64, b: &Value) -> anyhow::Result<i64> {
    let mut vals = item_values(b)?;
    vals.insert(0, rusqlite::types::Value::from(coll));
    conn.execute(
        &format!(
            "INSERT INTO items(collection_id,{WRITE_COLS}) VALUES({})",
            (1..=vals.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(",")
        ),
        rusqlite::params_from_iter(vals),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_item(conn: &Connection, id: i64, b: &Value) -> anyhow::Result<()> {
    let mut vals = item_values(b)?;
    let sets = WRITE_COLS
        .split(',')
        .enumerate()
        .map(|(n, c)| format!("{}=?{}", c.trim(), n + 1))
        .collect::<Vec<_>>()
        .join(",");
    vals.push(rusqlite::types::Value::from(id));
    let n = conn.execute(
        &format!(
            "UPDATE items SET {sets},updated_at=datetime('now') WHERE id=?{}",
            vals.len()
        ),
        rusqlite::params_from_iter(vals),
    )?;
    if n == 0 {
        return Err(anyhow!("条目不存在"));
    }
    Ok(())
}

async fn items_create(State(app): State<App>, Path(key): Path<String>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let coll = coll_id(&conn, &key)?;
    let id = insert_item(&conn, coll, &b)?;
    Ok(Json(json!({ "id": id })))
}

async fn items_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    update_item(&conn, id, &b)?;
    Ok(Json(json!({ "ok": true })))
}

pub fn delete_item(app: &App, conn: &Connection, id: i64) -> anyhow::Result<()> {
    let logo: Option<String> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .unwrap_or(None);
    conn.execute("DELETE FROM items WHERE id=?1", [id])?;
    remove_logo_file(app, logo);
    Ok(())
}

async fn items_delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    delete_item(&app2, &conn, id)?;
    Ok(Json(json!({ "ok": true })))
}

/// 记一笔续费：写台账并按库的到期模型推进日期。
/// anchor='next' 推进 next_renewal（逾期则连推到今天之后），anchor='last' 把上次续费记为今天。
pub fn renew_item(conn: &Connection, id: i64, b: &Value) -> anyhow::Result<Value> {
    let row: Option<(String, String, Option<f64>, Option<String>, Option<String>, Option<i64>, Option<String>)> =
        conn.query_row(
            "SELECT c.key, c.due_anchor, i.price, i.currency, i.cycle, i.cycle_days, i.next_renewal
             FROM items i JOIN collections c ON c.id=i.collection_id WHERE i.id=?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .ok();
    let Some((key, anchor, price, currency, cycle, cycle_days, next)) = row else {
        return Err(anyhow!("条目不存在"));
    };
    let today = engine::today();
    conn.execute(
        "INSERT INTO renewal_ledger(kind,item_id,renewed_at,amount,currency,note)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            key,
            id,
            today.to_string(),
            f(b, "amount").or(price),
            s(b, "currency").or(currency),
            s(b, "note"),
        ],
    )?;
    if anchor == "next" {
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
                "UPDATE items SET next_renewal=?1,updated_at=datetime('now') WHERE id=?2",
                params![n, id],
            )?;
        }
        return Ok(json!({ "next_renewal": new_next }));
    }
    conn.execute(
        "UPDATE items SET last_renewed=?1,updated_at=datetime('now') WHERE id=?2",
        params![today.to_string(), id],
    )?;
    Ok(json!({ "last_renewed": today.to_string() }))
}

async fn items_renew(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(renew_item(&conn, id, &b)?))
}

/* ── 条目图标：原始字节上传（?ext= 定格式），文件存数据目录 logos/，列存文件名 ── */

fn logo_name_ok(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// 上传字节的魔数须与声明格式一致，防止把可执行内容伪装成图片存进来
fn logo_bytes_ok(ext: &str, b: &[u8]) -> bool {
    match ext {
        "png" => b.starts_with(b"\x89PNG"),
        "jpg" | "jpeg" => b.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => b.starts_with(b"GIF8"),
        "webp" => b.len() > 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP",
        "ico" => b.starts_with(&[0x00, 0x00, 0x01, 0x00]),
        "svg" => {
            let head = String::from_utf8_lossy(&b[..b.len().min(256)]).to_lowercase();
            let head = head.trim_start_matches('\u{feff}').trim_start();
            head.starts_with("<svg") || head.starts_with("<?xml")
        }
        _ => false,
    }
}

pub fn remove_logo_file(app: &App, name: Option<String>) {
    if let Some(n) = name.filter(|n| logo_name_ok(n)) {
        let _ = std::fs::remove_file(app.data_dir.join("logos").join(n));
    }
}

pub fn set_logo(
    app: &App,
    conn: &Connection,
    id: i64,
    ext: &str,
    body: &[u8],
) -> anyhow::Result<String> {
    if !matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "svg" | "gif" | "ico") {
        return Err(anyhow!("不支持的图片格式"));
    }
    if body.is_empty() || body.len() > 1_000_000 {
        return Err(anyhow!("图片为空或超过 1MB"));
    }
    if !logo_bytes_ok(ext, body) {
        return Err(anyhow!("图片内容与声明格式不符"));
    }
    let old: Option<Option<String>> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .ok();
    let Some(old) = old else {
        return Err(anyhow!("条目不存在"));
    };
    let dir = app.data_dir.join("logos");
    std::fs::create_dir_all(&dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let name = format!("item-{id}-{stamp}.{ext}");
    std::fs::write(dir.join(&name), body)?;
    conn.execute(
        "UPDATE items SET logo=?1,updated_at=datetime('now') WHERE id=?2",
        params![name, id],
    )?;
    remove_logo_file(app, old);
    Ok(name)
}

async fn logo_set(
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

pub fn clear_logo(app: &App, conn: &Connection, id: i64) -> anyhow::Result<()> {
    let old: Option<Option<String>> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .ok();
    let Some(old) = old else {
        return Err(anyhow!("条目不存在"));
    };
    conn.execute(
        "UPDATE items SET logo=NULL,updated_at=datetime('now') WHERE id=?1",
        [id],
    )?;
    remove_logo_file(app, old);
    Ok(())
}

async fn logo_clear(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    clear_logo(&app2, &conn, id)?;
    Ok(Json(json!({ "ok": true })))
}

// 与媒体封面同款：文件名白名单 + 静态读 + 长缓存
async fn logo_file(State(app): State<App>, Path(name): Path<String>) -> Result<Response, ApiError> {
    if !logo_name_ok(&name) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let path = app.data_dir.join("logos").join(&name);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        _ => "image/jpeg",
    };
    let mut resp = (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=604800"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response();
    if mime == "image/svg+xml" {
        // SVG 可携带脚本：<img> 引用本就不执行，这里再把直接打开的场景沙箱化
        resp.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            header::HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
        );
    }
    Ok(resp)
}
