//! 字段注册：自定义列（值存实体表 extra JSON，键 c<id>）与内置自由词表列的选项管理。
//! 状态/周期/币种/类别等参与后端语义的词表不在此列，前端只读展示。

use anyhow::anyhow;
use axum::{
    extract::{Path, State},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::api::{s, R};
use crate::App;

const FTYPES: &[&str] = &["text", "num", "sel", "multi", "date", "star"];

// (前端表名, SQL 表名)
const TBLS: &[(&str, &str)] = &[
    ("subs", "subscriptions"),
    ("sims", "sim_cards"),
    ("vps", "vps_instances"),
    ("media", "media_items"),
];

// 内置列里允许编辑选项的自由词表列：(tbl, key, SQL 列名, 值是否 JSON 数组)
const BUILTIN_OPT: &[(&str, &str, &str, bool)] = &[
    ("subs", "category", "category", false),
    ("subs", "payment_method", "payment_method", false),
    ("vps", "purpose", "purpose", false),
    ("vps", "locations", "locations", true),
    ("vps", "routes", "routes", true),
    ("sims", "forms", "forms", true),
];

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/fields", get(list).post(create))
        .route("/api/fields/options", put(set_options))
        .route("/api/fields/rename_option", post(rename_option))
        .route("/api/fields/remove_option", post(remove_option))
        .route("/api/fields/{id}", put(update).delete(delete_field))
}

fn sql_table(tbl: &str) -> anyhow::Result<&'static str> {
    TBLS.iter()
        .find(|(t, _)| *t == tbl)
        .map(|(_, sql)| *sql)
        .ok_or_else(|| anyhow!("未知表：{tbl}"))
}

// 选项存对象数组 [{v, c?}]：v=值，c=标签调色板号 0..9（缺省=前端按值哈希定色）。
// 入参兼容纯字符串（老形态/顺手写法），一律常规化并按 v 去重。
fn opts_array(b: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for x in b.get("options").and_then(|x| x.as_array()).into_iter().flatten() {
        let (v, c) = match x {
            Value::String(s) => (s.trim().to_string(), None),
            Value::Object(o) => (
                o.get("v").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).unwrap_or_default(),
                o.get("c").and_then(|c| c.as_i64()).filter(|c| (0..10).contains(c)),
            ),
            _ => (String::new(), None),
        };
        if v.is_empty() || out.iter().any(|o| o["v"] == v.as_str()) {
            continue;
        }
        out.push(match c {
            Some(c) => json!({ "v": v, "c": c }),
            None => json!({ "v": v }),
        });
    }
    out
}

fn field_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let options: String = r.get(5)?;
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "tbl": r.get::<_, String>(1)?,
        "key": r.get::<_, String>(2)?,
        "name": r.get::<_, String>(3)?,
        "ftype": r.get::<_, String>(4)?,
        "options": serde_json::from_str::<Value>(&options).unwrap_or_else(|_| json!([])),
        "builtin": r.get::<_, i64>(6)? != 0,
        "pos": r.get::<_, i64>(7)?,
    }))
}

async fn list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id,tbl,key,name,ftype,options,builtin,pos FROM fields ORDER BY tbl,pos,id")?;
    let rows: Vec<Value> = stmt.query_map([], field_json)?.collect::<rusqlite::Result<_>>()?;
    Ok(Json(json!(rows)))
}

// 新建自定义列：key 用 c<id>，值挂在实体行 extra JSON 里
async fn create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| anyhow!("缺少 tbl"))?;
    sql_table(&tbl)?;
    let name = s(&b, "name").ok_or_else(|| anyhow!("列名不能为空"))?;
    let ftype = s(&b, "ftype").unwrap_or_else(|| "text".into());
    if !FTYPES.contains(&ftype.as_str()) {
        return Err(anyhow!("未知类型：{ftype}").into());
    }
    let conn = app.db.lock().unwrap();
    let pos: i64 = conn.query_row(
        "SELECT coalesce(max(pos),0)+1 FROM fields WHERE tbl=?1",
        [&tbl],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO fields(tbl,key,name,ftype,options,builtin,pos) VALUES(?1,'',?2,?3,'[]',0,?4)",
        params![tbl, name, ftype, pos],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute("UPDATE fields SET key='c'||id WHERE id=?1", [id])?;
    let row = conn.query_row(
        "SELECT id,tbl,key,name,ftype,options,builtin,pos FROM fields WHERE id=?1",
        [id],
        field_json,
    )?;
    Ok(Json(row))
}

// 重命名自定义列
async fn update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let name = s(&b, "name").ok_or_else(|| anyhow!("列名不能为空"))?;
    let conn = app.db.lock().unwrap();
    let n = conn.execute(
        "UPDATE fields SET name=?1 WHERE id=?2 AND builtin=0",
        params![name, id],
    )?;
    if n == 0 {
        return Err(anyhow!("列不存在或不可改名").into());
    }
    Ok(Json(json!({ "ok": true })))
}

// 删除自定义列：连同各行 extra 里挂的值一起清掉
async fn delete_field(State(app): State<App>, Path(id): Path<i64>) -> R {
    let conn = app.db.lock().unwrap();
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT tbl,key FROM fields WHERE id=?1 AND builtin=0",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((tbl, key)) = row else {
        return Err(anyhow!("列不存在或不可删除").into());
    };
    let table = sql_table(&tbl)?;
    rewrite_extra(&conn, table, |obj| obj.remove(&key).is_some())?;
    conn.execute("DELETE FROM fields WHERE id=?1", [id])?;
    Ok(Json(json!({ "ok": true })))
}

// 定位一个可管理选项的字段：内置白名单列，或本表的自定义 sel/multi 列
enum Target {
    Col(&'static str, &'static str),      // 单值 SQL 列
    ArrCol(&'static str, &'static str),   // JSON 数组 SQL 列
    Extra(&'static str, String),          // 自定义列：extra[key]
}

fn resolve(conn: &Connection, tbl: &str, key: &str) -> anyhow::Result<Target> {
    if let Some((_, _, col, arr)) = BUILTIN_OPT.iter().find(|(t, k, _, _)| *t == tbl && *k == key) {
        let table = sql_table(tbl)?;
        return Ok(if *arr { Target::ArrCol(table, col) } else { Target::Col(table, col) });
    }
    let custom: Option<String> = conn
        .query_row(
            "SELECT ftype FROM fields WHERE tbl=?1 AND key=?2 AND builtin=0",
            params![tbl, key],
            |r| r.get(0),
        )
        .ok();
    match custom.as_deref() {
        Some("sel") | Some("multi") => Ok(Target::Extra(sql_table(tbl)?, key.to_string())),
        Some(_) => Err(anyhow!("该列类型没有选项")),
        None => Err(anyhow!("该列不支持编辑选项")),
    }
}

// 设置字段的选项清单（内置列首次编辑时落一行 builtin=1 记录）
async fn set_options(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| anyhow!("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| anyhow!("缺少 key"))?;
    let conn = app.db.lock().unwrap();
    let target = resolve(&conn, &tbl, &key)?;
    let ftype = match target {
        Target::Col(..) => "sel",
        Target::ArrCol(..) => "multi",
        Target::Extra(..) => "",
    };
    let opts = serde_json::to_string(&opts_array(&b))?;
    if ftype.is_empty() {
        conn.execute(
            "UPDATE fields SET options=?1 WHERE tbl=?2 AND key=?3",
            params![opts, tbl, key],
        )?;
    } else {
        conn.execute(
            "INSERT INTO fields(tbl,key,ftype,options,builtin) VALUES(?1,?2,?3,?4,1)
             ON CONFLICT(tbl,key) DO UPDATE SET options=excluded.options",
            params![tbl, key, ftype, opts],
        )?;
    }
    Ok(Json(json!({ "ok": true })))
}

// 选项改名：更新词表并传播到所有行
async fn rename_option(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| anyhow!("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| anyhow!("缺少 key"))?;
    let from = s(&b, "from").ok_or_else(|| anyhow!("缺少 from"))?;
    let to = s(&b, "to").ok_or_else(|| anyhow!("缺少 to"))?;
    if from == to {
        return Ok(Json(json!({ "ok": true })));
    }
    let conn = app.db.lock().unwrap();
    let target = resolve(&conn, &tbl, &key)?;
    swap_option_in_list(&conn, &tbl, &key, &from, Some(&to))?;
    match target {
        Target::Col(table, col) => {
            conn.execute(
                &format!("UPDATE {table} SET {col}=?1,updated_at=datetime('now') WHERE {col}=?2"),
                params![to, from],
            )?;
        }
        Target::ArrCol(table, col) => rewrite_arr_col(&conn, table, col, &from, Some(&to))?,
        Target::Extra(table, k) => rewrite_extra(&conn, table, |obj| swap_extra_value(obj, &k, &from, Some(&to)))?,
    }
    Ok(Json(json!({ "ok": true })))
}

// 删除选项：移出词表并从所有行清掉该值
async fn remove_option(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| anyhow!("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| anyhow!("缺少 key"))?;
    let value = s(&b, "value").ok_or_else(|| anyhow!("缺少 value"))?;
    let conn = app.db.lock().unwrap();
    let target = resolve(&conn, &tbl, &key)?;
    swap_option_in_list(&conn, &tbl, &key, &value, None)?;
    match target {
        Target::Col(table, col) => {
            conn.execute(
                &format!("UPDATE {table} SET {col}=NULL,updated_at=datetime('now') WHERE {col}=?1"),
                params![value],
            )?;
        }
        Target::ArrCol(table, col) => rewrite_arr_col(&conn, table, col, &value, None)?,
        Target::Extra(table, k) => rewrite_extra(&conn, table, |obj| swap_extra_value(obj, &k, &value, None))?,
    }
    Ok(Json(json!({ "ok": true })))
}

// 词表里改名/移除一个选项（无该字段记录时跳过——词表本就来自数据值）
fn swap_option_in_list(conn: &Connection, tbl: &str, key: &str, from: &str, to: Option<&str>) -> anyhow::Result<()> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT options FROM fields WHERE tbl=?1 AND key=?2",
            params![tbl, key],
            |r| r.get(0),
        )
        .ok();
    let Some(stored) = stored else { return Ok(()) };
    let mut opts: Vec<Value> = serde_json::from_str(&stored).unwrap_or_default();
    for o in opts.iter_mut() {
        if let Value::String(s) = o {
            *o = json!({ "v": s.clone() }); // 老形态常规化
        }
    }
    match to {
        // 原位改名保留颜色；目标已存在则合并（丢弃被改名项）
        Some(to) if !opts.iter().any(|o| o["v"] == to) => {
            if let Some(p) = opts.iter().position(|o| o["v"] == from) {
                opts[p]["v"] = json!(to);
            }
        }
        _ => opts.retain(|o| o["v"] != from),
    }
    conn.execute(
        "UPDATE fields SET options=?1 WHERE tbl=?2 AND key=?3",
        params![serde_json::to_string(&opts)?, tbl, key],
    )?;
    Ok(())
}

// JSON 数组列逐行改写（表都很小，读改写最直白）
fn rewrite_arr_col(conn: &Connection, table: &str, col: &str, from: &str, to: Option<&str>) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(&format!("SELECT id,{col} FROM {table} WHERE {col} IS NOT NULL"))?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, text) in rows {
        let Ok(mut arr) = serde_json::from_str::<Vec<String>>(&text) else { continue };
        if !arr.iter().any(|x| x == from) {
            continue;
        }
        swap_in_vec(&mut arr, from, to);
        conn.execute(
            &format!("UPDATE {table} SET {col}=?1,updated_at=datetime('now') WHERE id=?2"),
            params![serde_json::to_string(&arr)?, id],
        )?;
    }
    Ok(())
}

// 原位改名（目标已存在则合并去重）或移除
fn swap_in_vec(arr: &mut Vec<String>, from: &str, to: Option<&str>) {
    match to {
        Some(to) if !arr.iter().any(|x| x == to) => {
            if let Some(p) = arr.iter().position(|x| x == from) {
                arr[p] = to.to_string();
            }
        }
        _ => arr.retain(|x| x != from),
    }
}

// 自定义列值：单值相等则替换/删除，数组则替换/移除元素
fn swap_extra_value(obj: &mut serde_json::Map<String, Value>, key: &str, from: &str, to: Option<&str>) -> bool {
    match obj.get_mut(key) {
        Some(Value::String(v)) if v == from => {
            match to {
                Some(t) => *v = t.to_string(),
                None => { obj.remove(key); }
            }
            true
        }
        Some(Value::Array(arr)) if arr.iter().any(|x| x.as_str() == Some(from)) => {
            let mut ss: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(String::from)).collect();
            swap_in_vec(&mut ss, from, to);
            *arr = ss.into_iter().map(Value::from).collect();
            true
        }
        _ => false,
    }
}

// 逐行改写 extra JSON；f 返回是否有改动
fn rewrite_extra(
    conn: &Connection,
    table: &str,
    mut f: impl FnMut(&mut serde_json::Map<String, Value>) -> bool,
) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(&format!("SELECT id,extra FROM {table} WHERE extra IS NOT NULL"))?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, text) in rows {
        let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(&text) else { continue };
        if !f(&mut obj) {
            continue;
        }
        conn.execute(
            &format!("UPDATE {table} SET extra=?1,updated_at=datetime('now') WHERE id=?2"),
            params![serde_json::to_string(&Value::Object(obj))?, id],
        )?;
    }
    Ok(())
}
