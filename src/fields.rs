//! 字段注册：自定义列（值存实体表 extra JSON，键 c<id>）与内置自由词表列的选项管理。
//! 状态/周期/币种/类别等参与后端语义的词表不在此列，前端只读展示。

use axum::{
    extract::{Path, State},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::api::{bad, missing, s, R};
use crate::App;

const FTYPES: &[&str] = &["text", "num", "sel", "multi", "date", "star"];

/// 字段所属的数据源：库（值在 items.extra，按 collection_id 圈定）或独立表（媒体库）。
enum Owner {
    Collection(i64),
    Table(&'static str),
}

/// tbl 既可能是库键，也可能是 'media' 这种独立表；库表已泛化，不再有按表名写死的映射。
fn owner(conn: &Connection, tbl: &str) -> anyhow::Result<Owner> {
    if tbl == "media" {
        return Ok(Owner::Table("media_items"));
    }
    conn.query_row("SELECT id FROM collections WHERE key=?1", [tbl], |r| r.get(0))
        .map(Owner::Collection)
        .map_err(|_| bad(format!("未知表：{tbl}")))
}

// 预置库里允许编辑选项的自由词表字段。泛化后它们的值都在 extra 里，
// 不再需要区分 SQL 列还是 JSON 数组列——swap_extra_value 按实际值形态处理。
const BUILTIN_OPT: &[(&str, &str, &str)] = &[
    ("subs", "category", "sel"),
    ("subs", "payment_method", "sel"),
    ("vps", "purpose", "sel"),
    ("vps", "locations", "multi"),
    ("vps", "routes", "multi"),
    ("sims", "forms", "multi"),
];

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/fields", get(list).post(create))
        .route("/api/fields/options", put(set_options))
        .route("/api/fields/order", put(set_order))
        .route("/api/fields/semantics", put(set_semantics))
        .route("/api/fields/add_status", post(add_status))
        .route("/api/fields/rename_option", post(rename_option))
        .route("/api/fields/remove_option", post(remove_option))
        .route("/api/fields/{id}", put(update).delete(delete_field))
}

/// 逐行改写时的定位条件：库按 collection_id 圈定，独立表全表。
fn scope(conn: &Connection, tbl: &str) -> anyhow::Result<(&'static str, String)> {
    Ok(match owner(conn, tbl)? {
        Owner::Collection(id) => ("items", format!("collection_id={id}")),
        Owner::Table(t) => (t, "1".into()),
    })
}

// 选项存对象数组 [{v, c?, spend?, alert?, timeline?}]：v=值，c=标签调色板号 0..9
//（缺省=前端按值哈希定色）；状态词表的选项另带三个语义标记，engine 据此判断
// 计支出 / 发提醒 / 上到期时间线。入参兼容纯字符串（老形态/顺手写法），一律常规化并按 v 去重。
const SEM_FLAGS: &[&str] = &["spend", "alert", "timeline"];

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        Some(Value::String(s)) => !s.is_empty() && s != "0" && s != "false",
        _ => false,
    }
}

fn opts_array(b: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for x in b.get("options").and_then(|x| x.as_array()).into_iter().flatten() {
        let (v, c, obj) = match x {
            Value::String(s) => (s.trim().to_string(), None, None),
            Value::Object(o) => (
                o.get("v").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).unwrap_or_default(),
                o.get("c").and_then(|c| c.as_i64()).filter(|c| (0..10).contains(c)),
                Some(o),
            ),
            _ => (String::new(), None, None),
        };
        if v.is_empty() || out.iter().any(|o| o["v"] == v.as_str()) {
            continue;
        }
        let mut item = json!({ "v": v });
        if let Some(c) = c {
            item["c"] = json!(c);
        }
        // 语义标记只在传了的时候落表，没传的选项不凭空获得语义
        for flag in SEM_FLAGS {
            if let Some(o) = obj {
                if o.contains_key(*flag) {
                    item[*flag] = json!(i64::from(truthy(o.get(*flag))));
                }
            }
        }
        out.push(item);
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
        "src": r.get::<_, String>(8)?,
        "shown": r.get::<_, i64>(9)? != 0,
        "config": r
            .get::<_, Option<String>>(10)?
            .and_then(|x| serde_json::from_str::<Value>(&x).ok())
            .unwrap_or(Value::Null),
    }))
}

async fn list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id,tbl,key,name,ftype,options,builtin,pos,src,shown,config FROM fields ORDER BY tbl,pos,id")?;
    let rows: Vec<Value> = stmt.query_map([], field_json)?.collect::<rusqlite::Result<_>>()?;
    Ok(Json(json!(rows)))
}

// 新建自定义列：key 用 c<id>，值挂在实体行 extra JSON 里
async fn create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let name = s(&b, "name").ok_or_else(|| bad("列名不能为空"))?;
    let ftype = s(&b, "ftype").unwrap_or_else(|| "text".into());
    if !FTYPES.contains(&ftype.as_str()) {
        return Err(bad(format!("未知类型：{ftype}")).into());
    }
    let conn = app.db.lock().unwrap();
    owner(&conn, &tbl)?;
    let pos: i64 = conn.query_row(
        "SELECT coalesce(max(pos),0)+1 FROM fields WHERE tbl=?1",
        [&tbl],
        |r| r.get(0),
    )?;
    // 键要等 id 才拼得出，所以两条语句得绑在一起：断在中间会留下一行 key=''，
    // 而 UNIQUE(tbl,key) 会让这张表从此再也加不了列，得进库删行才能恢复
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO fields(tbl,key,name,ftype,options,builtin,pos) VALUES(?1,'',?2,?3,'[]',0,?4)",
        params![tbl, name, ftype, pos],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute("UPDATE fields SET key='c'||id WHERE id=?1", [id])?;
    let row = tx.query_row(
        "SELECT id,tbl,key,name,ftype,options,builtin,pos,src,shown,config FROM fields WHERE id=?1",
        [id],
        field_json,
    )?;
    tx.commit()?;
    Ok(Json(row))
}

// 改列的显示名与是否默认上表；显示名纯属呈现，引擎字段也可以改
async fn update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let name = s(&b, "name").ok_or_else(|| bad("列名不能为空"))?;
    let conn = app.db.lock().unwrap();
    let n = match b.get("shown") {
        Some(v) => {
            let shown = i64::from(truthy(Some(v)));
            // 名称列承载行的详情入口，且表头与行读同一份字段集——撤下它就会整表错位
            let key: String = conn
                .query_row("SELECT key FROM fields WHERE id=?1", [id], |r| r.get(0))
                .map_err(|_| missing("列不存在"))?;
            if shown == 0 && key == "name" {
                return Err(bad("名称列必须留在表格上").into());
            }
            conn.execute(
                "UPDATE fields SET name=?1,shown=?2 WHERE id=?3",
                params![name, shown, id],
            )?
        }
        None => conn.execute("UPDATE fields SET name=?1 WHERE id=?2", params![name, id])?,
    };
    if n == 0 {
        return Err(missing("列不存在").into());
    }
    Ok(Json(json!({ "ok": true })))
}

// 字段顺序：整份键序落成 pos。这是库级设置（决定新设备看到的默认列序与详情表单的次序），
// 与存在 localStorage 里的本机列序是两回事。
async fn set_order(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let keys: Vec<&str> = b
        .get("keys")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    if keys.is_empty() {
        return Err(bad("缺少 keys").into());
    }
    let conn = app.db.lock().unwrap();
    owner(&conn, &tbl)?;
    for (n, k) in keys.iter().enumerate() {
        conn.execute(
            "UPDATE fields SET pos=?1 WHERE tbl=?2 AND key=?3",
            params![n as i64 + 1, tbl, k],
        )?;
    }
    Ok(Json(json!({ "ok": true })))
}

// 状态语义：只改状态词表选项上的 spend/alert/timeline 三个标记，不碰值本身。
// 状态是 items 的真列，改名/删值得连行数据一起迁移，那不在这条路上做。
async fn set_semantics(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| bad("缺少 key"))?;
    let conn = app.db.lock().unwrap();
    let stored: String = conn
        .query_row(
            "SELECT options FROM fields WHERE tbl=?1 AND key=?2 AND ftype='status'",
            params![tbl, key],
            |r| r.get(0),
        )
        .map_err(|_| bad("该列没有状态词表"))?;
    let mut opts: Vec<Value> = serde_json::from_str(&stored).unwrap_or_default();
    let want = opts_array(&b);
    for o in opts.iter_mut() {
        let Some(w) = want.iter().find(|w| w["v"] == o["v"]) else { continue };
        // opts_array 只保留调用方真传了的标记，没传的保持原样
        for flag in SEM_FLAGS {
            if let Some(v) = w.get(*flag) {
                o[*flag] = v.clone();
            }
        }
    }
    conn.execute(
        "UPDATE fields SET options=?1 WHERE tbl=?2 AND key=?3",
        params![serde_json::to_string(&opts)?, tbl, key],
    )?;
    Ok(Json(json!({ "ok": true })))
}

/// 状态词表唯一开放的写口：**只能追加**。改名与删除要连行数据一起迁移（状态是 items 的真列，
/// 还驱动支出/提醒/时间线三层语义），那两件事不在这条路上做。新值不带语义标记，
/// engine 读不到标记就按内置默认理解——`status_sem` 对未知值返回三项全关，用户再去语义浮层里勾。
async fn add_status(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| bad("缺少 key"))?;
    let value = s(&b, "value").ok_or_else(|| bad("状态值不能为空"))?;
    let conn = app.db.lock().unwrap();
    let (id, stored): (i64, String) = conn
        .query_row(
            "SELECT id,options FROM fields WHERE tbl=?1 AND key=?2 AND ftype='status'",
            params![tbl, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| bad("该列没有状态词表"))?;
    let mut opts: Vec<Value> = serde_json::from_str(&stored).unwrap_or_default();
    for o in opts.iter_mut() {
        if let Value::String(s) = o {
            *o = json!({ "v": s.clone() }); // 老形态常规化
        }
    }
    if opts.iter().any(|o| o["v"] == value.as_str()) {
        return Err(bad(format!("状态「{value}」已经在词表里")).into());
    }
    opts.push(json!({ "v": value, "spend": 0, "alert": 0, "timeline": 0 }));
    conn.execute(
        "UPDATE fields SET options=?1 WHERE id=?2",
        params![serde_json::to_string(&opts)?, id],
    )?;
    Ok(Json(json!({ "ok": true })))
}

// 删除列：只有值挂在 extra 里的列可删（引擎真列与算出来的列删了没有意义），
// 连同各行 extra 里挂的值一起清掉
async fn delete_field(State(app): State<App>, Path(id): Path<i64>) -> R {
    let conn = app.db.lock().unwrap();
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT tbl,key FROM fields WHERE id=?1 AND src='extra'",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((tbl, key)) = row else {
        return Err(missing("列不存在或不可删除").into());
    };
    let (table, cond) = scope(&conn, &tbl)?;
    let t = Target { table, cond, key: key.clone(), seed_ftype: None };
    // 清值与注销列绑在一起：只清了一半的话，列没了但值还挂在各行的 extra 里
    let tx = conn.unchecked_transaction()?;
    rewrite_extra(&tx, &t, |obj| obj.remove(&key).is_some())?;
    tx.execute("DELETE FROM fields WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

// 一个可管理选项的字段：预置库的自由词表字段，或本库/本表的自定义 sel/multi 字段。
// 泛化后两者的值都在 extra 里，所以定位结果只需要"改哪张表的哪些行、哪个键"。
struct Target {
    table: &'static str,
    cond: String,
    key: String,
    /// 预置词表字段首次编辑选项时要补一行 fields 记录，这里给它的类型
    seed_ftype: Option<&'static str>,
}

fn resolve(conn: &Connection, tbl: &str, key: &str) -> anyhow::Result<Target> {
    let (table, cond) = scope(conn, tbl)?;
    let mk = |seed_ftype| Target {
        table,
        cond: cond.clone(),
        key: key.to_string(),
        seed_ftype,
    };
    if let Some((_, _, ft)) = BUILTIN_OPT.iter().find(|(t, k, _)| *t == tbl && *k == key) {
        return Ok(mk(Some(ft)));
    }
    let custom: Option<String> = conn
        .query_row(
            "SELECT ftype FROM fields WHERE tbl=?1 AND key=?2 AND builtin=0",
            params![tbl, key],
            |r| r.get(0),
        )
        .ok();
    match custom.as_deref() {
        Some("sel") | Some("multi") => Ok(mk(None)),
        Some(_) => Err(bad("该列类型没有选项")),
        None => Err(bad("该列不支持编辑选项")),
    }
}

// 设置字段的选项清单（内置列首次编辑时落一行 builtin=1 记录）
async fn set_options(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| bad("缺少 key"))?;
    let conn = app.db.lock().unwrap();
    let target = resolve(&conn, &tbl, &key)?;
    let opts = serde_json::to_string(&opts_array(&b))?;
    match target.seed_ftype {
        Some(ftype) => conn.execute(
            "INSERT INTO fields(tbl,key,ftype,options,builtin) VALUES(?1,?2,?3,?4,1)
             ON CONFLICT(tbl,key) DO UPDATE SET options=excluded.options",
            params![tbl, key, ftype, opts],
        )?,
        None => conn.execute(
            "UPDATE fields SET options=?1 WHERE tbl=?2 AND key=?3",
            params![opts, tbl, key],
        )?,
    };
    Ok(Json(json!({ "ok": true })))
}

// 选项改名：更新词表并传播到所有行
async fn rename_option(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| bad("缺少 key"))?;
    let from = s(&b, "from").ok_or_else(|| bad("缺少 from"))?;
    let to = s(&b, "to").ok_or_else(|| bad("缺少 to"))?;
    if from == to {
        return Ok(Json(json!({ "ok": true })));
    }
    let conn = app.db.lock().unwrap();
    let t = resolve(&conn, &tbl, &key)?;
    // 词表与各行的值要么一起改完，要么一条都不改：半途失败留下的是「词表已改名、
    // 行里还是旧值」的错位，界面上看不出来，只在筛选时表现为对不上
    let tx = conn.unchecked_transaction()?;
    swap_option_in_list(&tx, &tbl, &key, &from, Some(&to))?;
    rewrite_extra(&tx, &t, |obj| {
        swap_extra_value(obj, &t.key, &from, Some(&to))
    })?;
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

// 删除选项：移出词表并从所有行清掉该值
async fn remove_option(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| bad("缺少 key"))?;
    let value = s(&b, "value").ok_or_else(|| bad("缺少 value"))?;
    let conn = app.db.lock().unwrap();
    let t = resolve(&conn, &tbl, &key)?;
    let tx = conn.unchecked_transaction()?;
    swap_option_in_list(&tx, &tbl, &key, &value, None)?;
    rewrite_extra(&tx, &t, |obj| swap_extra_value(obj, &t.key, &value, None))?;
    tx.commit()?;
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
    t: &Target,
    mut f: impl FnMut(&mut serde_json::Map<String, Value>) -> bool,
) -> anyhow::Result<()> {
    let (table, cond) = (t.table, &t.cond);
    let mut stmt =
        conn.prepare(&format!("SELECT id,extra FROM {table} WHERE {cond} AND extra IS NOT NULL"))?;
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
