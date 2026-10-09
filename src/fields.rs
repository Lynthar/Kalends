//! 字段注册：自定义列（值存实体表 extra JSON，键 c<id>）与内置自由词表列的选项管理。
//! 状态/周期/币种/类别等参与后端语义的词表不在此列，前端只读展示。

use axum::{
    extract::{Path, State},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::api::{bad, check_shape, missing, s, R};
use crate::App;

/// 可建的列类型。`star` 已撤掉：它只是"数字加个星形壳"——要打分用 `num`，要档位用 `sel`。
pub(crate) const FTYPES: &[&str] =
    &["text", "num", "sel", "multi", "date", "tel", "url", "email"];

/// tbl 是库键（字段值在 `items.extra`，按 `collection_id` 圈定）；库表已泛化，不再有按表名写死的映射。
fn owner(conn: &Connection, tbl: &str) -> anyhow::Result<i64> {
    conn.query_row("SELECT id FROM collections WHERE key=?1", [tbl], |r| r.get(0))
        .optional()?
        .ok_or_else(|| bad(format!("未知表：{tbl}")))
}

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

/// 逐行改写时的定位条件：按 `collection_id` 圈定该库的行。
fn scope(conn: &Connection, tbl: &str) -> anyhow::Result<(&'static str, String)> {
    let id = owner(conn, tbl)?;
    Ok(("items", format!("collection_id={id}")))
}

// 选项存对象数组 [{v, c?, spend?, alert?, timeline?}]：v=值，c=标签调色板号 0..9
//（缺省=前端按值哈希定色）；状态词表的选项另带三个语义标记，engine 据此判断
// 计支出 / 发提醒 / 上到期时间线。入参兼容纯字符串（老形态/顺手写法），一律常规化并按 v 去重。
const SEM_FLAGS: &[&str] = &["spend", "alert", "timeline"];

/// 布尔标记只收 true/false 与 0/1：宽松地读，`"no"` 就成了真。
fn flag(v: &Value, what: &str) -> anyhow::Result<bool> {
    match v {
        Value::Bool(b) => Ok(*b),
        _ => match v.as_i64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(bad(format!("{what} 要是 true / false 或 0 / 1"))),
        },
    }
}

/// `options` 必须是数组，元素是文本或带文本 `v` 的对象；读不出就 400——当成空数组的话，
/// 一个传错类型的请求会把整份词表连同颜色清掉。
fn opts_array(b: &Value) -> anyhow::Result<Vec<Value>> {
    let arr = b.get("options").and_then(Value::as_array).ok_or_else(|| bad("options 要是数组"))?;
    let mut out: Vec<Value> = Vec::new();
    for x in arr {
        let (v, c, obj) = match x {
            Value::String(s) => (s.trim().to_string(), None, None),
            Value::Object(o) => (
                o.get("v").and_then(Value::as_str).ok_or_else(|| bad("选项的 v 要是文本"))?.trim().to_string(),
                o.get("c").and_then(Value::as_i64).filter(|c| (0..10).contains(c)),
                Some(o),
            ),
            _ => return Err(bad("选项要是文本或 {v} 对象")),
        };
        if v.is_empty() || out.iter().any(|o| o["v"] == v.as_str()) {
            continue;
        }
        let mut item = json!({ "v": v });
        if let Some(c) = c {
            item["c"] = json!(c);
        }
        // 语义标记只在传了的时候落表，没传的选项不凭空获得语义
        for f in SEM_FLAGS {
            if let Some(fv) = obj.and_then(|o| o.get(*f)) {
                item[*f] = json!(i64::from(flag(fv, f)?));
            }
        }
        out.push(item);
    }
    Ok(out)
}

fn field_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
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
    check_shape(&b, &["tbl", "name", "ftype"], &[], &[])?;
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
    let tx = conn.unchecked_transaction()?;
    let id = crate::db::next_id(&tx, "fields")?;
    tx.execute(
        "INSERT INTO fields(id,tbl,key,name,ftype,options,builtin,pos) VALUES(?1,?2,'c'||?1,?3,?4,'[]',0,?5)",
        params![id, tbl, name, ftype, pos],
    )?;
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
    // 列类型建后不可改。此前带 ftype 的请求被静默忽略——既不改也不说，调用方以为改成了
    if b.get("ftype").is_some() {
        return Err(bad("列类型建后不可改").into());
    }
    check_shape(&b, &["name"], &[], &[])?;
    let name = s(&b, "name").ok_or_else(|| bad("列名不能为空"))?;
    let shown = b.get("shown").map(|v| flag(v, "shown")).transpose()?;
    let conn = app.db.lock().unwrap();
    let n = match shown {
        Some(shown) => {
            let shown = i64::from(shown);
            // 名称列承载行的详情入口，且表头与行读同一份字段集——撤下它就会整表错位
            let key: String = conn
                .query_row("SELECT key FROM fields WHERE id=?1", [id], |r| r.get(0))
                .optional()?
                .ok_or_else(|| missing("列不存在"))?;
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
    check_shape(&b, &["tbl"], &[], &[])?;
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    // 掺了非文本就整份拒：静默滤掉的话，排出来的序与请求的不是一回事
    let keys: Vec<&str> = b
        .get("keys")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(Value::as_str).collect::<Option<_>>().ok_or_else(|| bad("keys 要是文本数组")))
        .transpose()?
        .unwrap_or_default();
    if keys.is_empty() {
        return Err(bad("缺少 keys").into());
    }
    let conn = app.db.lock().unwrap();
    owner(&conn, &tbl)?;
    // 整份序是一件事，半途断掉留下的是交错的 pos
    let tx = conn.unchecked_transaction()?;
    for (n, k) in keys.iter().enumerate() {
        tx.execute(
            "UPDATE fields SET pos=?1 WHERE tbl=?2 AND key=?3",
            params![n as i64 + 1, tbl, k],
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

// 状态语义：只改状态词表选项上的 spend/alert/timeline 三个标记，不碰值本身。
// 状态是 items 的真列，改名/删值得连行数据一起迁移，那不在这条路上做。
async fn set_semantics(State(app): State<App>, Json(b): Json<Value>) -> R {
    check_shape(&b, &["tbl", "key"], &[], &[])?;
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| bad("缺少 key"))?;
    let want = opts_array(&b)?;
    let conn = app.db.lock().unwrap();
    let stored: String = conn
        .query_row(
            "SELECT options FROM fields WHERE tbl=?1 AND key=?2 AND ftype='status'",
            params![tbl, key],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| bad("该列没有状态词表"))?;
    let mut opts: Vec<Value> = serde_json::from_str(&stored).unwrap_or_default();
    for o in &mut opts {
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
    check_shape(&b, &["tbl", "key", "value"], &[], &[])?;
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
        .optional()?
        .ok_or_else(|| bad("该列没有状态词表"))?;
    let mut opts: Vec<Value> = serde_json::from_str(&stored).unwrap_or_default();
    for o in &mut opts {
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
        .optional()?;
    let Some((tbl, key)) = row else {
        return Err(missing("列不存在或不可删除").into());
    };
    let (table, cond) = scope(&conn, &tbl)?;
    let t = Target { table, cond, key: key.clone() };
    // 清值、撤引用与注销列绑在一起：只做了一半的话，列没了但值还挂在各行的 extra 里
    let tx = conn.unchecked_transaction()?;
    rewrite_extra(&tx, &t, |obj| obj.remove(&key).is_some())?;
    tx.execute(
        "UPDATE collections SET subtitle=NULLIF(subtitle,?2), subline=NULLIF(subline,?2),
         note_field=NULLIF(note_field,?2) WHERE key=?1",
        params![tbl, key],
    )?;
    tx.execute("DELETE FROM fields WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

// 一个可管理选项的字段：任何 builtin=0 的 sel/multi 列——域字段与自定义列同权。
// 值一律在 extra 里，定位结果只需要"改哪张表的哪些行、哪个键"。
struct Target {
    table: &'static str,
    cond: String,
    key: String,
}

fn resolve(conn: &Connection, tbl: &str, key: &str) -> anyhow::Result<Target> {
    let (table, cond) = scope(conn, tbl)?;
    let ftype: Option<String> = conn
        .query_row(
            "SELECT ftype FROM fields WHERE tbl=?1 AND key=?2 AND builtin=0",
            params![tbl, key],
            |r| r.get(0),
        )
        .optional()?;
    match ftype.as_deref() {
        Some("sel" | "multi") => Ok(Target { table, cond, key: key.to_string() }),
        Some(_) => Err(bad("该列类型没有选项")),
        None => Err(bad("该列不支持编辑选项")),
    }
}

// 设置字段的选项清单
async fn set_options(State(app): State<App>, Json(b): Json<Value>) -> R {
    check_shape(&b, &["tbl", "key"], &[], &[])?;
    let tbl = s(&b, "tbl").ok_or_else(|| bad("缺少 tbl"))?;
    let key = s(&b, "key").ok_or_else(|| bad("缺少 key"))?;
    let opts = serde_json::to_string(&opts_array(&b)?)?;
    let conn = app.db.lock().unwrap();
    // 走到这里说明 fields 里一定有这一行（resolve 是靠查它才放行的）
    resolve(&conn, &tbl, &key)?;
    conn.execute(
        "UPDATE fields SET options=?1 WHERE tbl=?2 AND key=?3",
        params![opts, tbl, key],
    )?;
    Ok(Json(json!({ "ok": true })))
}

// 选项改名：更新词表并传播到所有行
async fn rename_option(State(app): State<App>, Json(b): Json<Value>) -> R {
    check_shape(&b, &["tbl", "key", "from", "to"], &[], &[])?;
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
    check_shape(&b, &["tbl", "key", "value"], &[], &[])?;
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
        .optional()?;
    let Some(stored) = stored else { return Ok(()) };
    let mut opts: Vec<Value> = serde_json::from_str(&stored).unwrap_or_default();
    for o in &mut opts {
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

// 多选值按集合改：旧值全部撤掉，新值落在第一个旧值的位置（已在就不再放）；别的元素连同非文本的原样留着
fn swap_in_vec(arr: &mut Vec<Value>, from: &str, to: Option<&str>) {
    let at = arr.iter().position(|x| x == from);
    arr.retain(|x| x != from);
    if let (Some(at), Some(to)) = (at, to) {
        if !arr.iter().any(|x| x == to) {
            arr.insert(at, json!(to));
        }
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
            swap_in_vec(arr, from, to);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::call;
    use crate::db::one;
    use axum::http::StatusCode;

    /// 新库上的字段路由，连同它底下的库（好直接播种与回读）。
    fn fresh() -> (Router, crate::Db) {
        let app = App::for_tests(crate::db::fresh_in_memory().unwrap(), std::path::Path::new("."));
        (router().with_state(app.clone()), app.db)
    }

    fn options(db: &crate::Db, tbl: &str, key: &str) -> Value {
        let stored: String = one(&db.lock().unwrap(), "SELECT options FROM fields WHERE tbl=?1 AND key=?2", [tbl, key]);
        serde_json::from_str(&stored).unwrap()
    }

    /// 删掉最新一列再建列，新列不能拿回旧键：没刷新的页面里还挂着旧列的值，键一复用，
    /// 它们就在新列里复活并被写回库。删列时库属性里指着它的引用一并撤掉。
    #[tokio::test]
    async fn a_deleted_column_never_hands_its_key_to_the_next_one() {
        let (r, db) = fresh();
        let create = |name: &str| Some(json!({ "tbl": "subs", "name": name }));
        let (_, first) = call(&r, "POST", "/api/fields", create("甲")).await;
        let key = first["key"].as_str().unwrap().to_string();
        db.lock().unwrap().execute("UPDATE collections SET note_field=?1 WHERE key='subs'", [&key]).unwrap();
        assert_eq!(call(&r, "DELETE", &format!("/api/fields/{}", first["id"]), None).await.0, StatusCode::OK);
        let (_, second) = call(&r, "POST", "/api/fields", create("乙")).await;
        assert_ne!(second["key"].as_str().unwrap(), key);
        let note: Option<String> = one(&db.lock().unwrap(), "SELECT note_field FROM collections WHERE key='subs'", []);
        assert_eq!(note, None, "库属性还指着已删的列");
    }

    /// 建列回的就是注册表里那一行：键由 id 派生、排在该库末尾、值进 extra、默认上表、没给类型按文本。
    /// 类型不认识或库不存在一律 400，什么都不建。
    #[tokio::test]
    async fn a_created_column_reads_back_as_registered() {
        let (r, db) = fresh();
        let count = || -> i64 { one(&db.lock().unwrap(), "SELECT count(*) FROM fields", []) };
        let before = count();
        for body in [json!({ "tbl": "vps", "name": "列", "ftype": "star" }), json!({ "tbl": "nope", "name": "列" })] {
            assert_eq!(call(&r, "POST", "/api/fields", Some(body.clone())).await.0, StatusCode::BAD_REQUEST, "{body}");
        }
        assert_eq!(count(), before, "被拒的请求不该建列");
        let last: i64 = one(&db.lock().unwrap(), "SELECT max(pos) FROM fields WHERE tbl='vps'", []);
        let (status, made) = call(&r, "POST", "/api/fields", Some(json!({ "tbl": "vps", "name": "机房" }))).await;
        assert_eq!(status, StatusCode::OK);
        let id = made["id"].as_i64().unwrap();
        assert_eq!(made, json!({
            "id": id, "tbl": "vps", "key": format!("c{id}"), "name": "机房", "ftype": "text", "options": [],
            "builtin": false, "pos": last + 1, "src": "extra", "shown": true, "config": null,
        }));
        let (_, all) = call(&r, "GET", "/api/fields", None).await;
        assert_eq!(all.as_array().unwrap().iter().find(|f| f["id"] == id), Some(&made));
    }

    /// 列类型建后不可改是既定行为；带 `ftype` 的更新此前被静默忽略——既不改也不说，
    /// 调用方以为改成了。要 400 说明白，不能 200。
    #[tokio::test]
    async fn an_update_carrying_ftype_is_rejected_not_ignored() {
        let (r, db) = fresh();
        let (id, ftype): (i64, String) = db
            .lock()
            .unwrap()
            .query_row("SELECT id, ftype FROM fields WHERE tbl='subs' AND key='price'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        let path = format!("/api/fields/{id}");
        // 负向对照：只改显示名照常
        assert_eq!(call(&r, "PUT", &path, Some(json!({ "name": "费用" }))).await.0, StatusCode::OK);
        assert_eq!(call(&r, "PUT", &path, Some(json!({ "name": "价格", "ftype": "text" }))).await.0, StatusCode::BAD_REQUEST);
        let now: (String, String) = db
            .lock()
            .unwrap()
            .query_row("SELECT name, ftype FROM fields WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!(now, ("费用".into(), ftype), "被拒的请求一个字段也不该写");
    }

    /// 名称列承载详情入口：可以改名，不能撤下表。别的列上下表照常，标记收 0 / 1。不存在的列 404。
    #[tokio::test]
    async fn the_name_column_can_be_renamed_but_never_hidden() {
        let (r, db) = fresh();
        let id_of = |key: &str| -> i64 { one(&db.lock().unwrap(), "SELECT id FROM fields WHERE tbl='subs' AND key=?1", [key]) };
        let read = |id: i64| -> (String, i64) {
            db.lock()
                .unwrap()
                .query_row("SELECT name, shown FROM fields WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
        };
        let put = |id: i64, body: Value| {
            let r = &r;
            async move { call(r, "PUT", &format!("/api/fields/{id}"), Some(body)).await.0 }
        };
        let (name, account) = (id_of("name"), id_of("account"));
        let before = read(name);
        assert_eq!(put(name, json!({ "name": "名", "shown": false })).await, StatusCode::BAD_REQUEST);
        assert_eq!(read(name), before, "被拒的请求一个字段也不该写");
        assert_eq!(put(name, json!({ "name": "名", "shown": true })).await, StatusCode::OK);
        assert_eq!(read(name), ("名".into(), 1));
        assert_eq!(put(account, json!({ "name": "账号", "shown": 1 })).await, StatusCode::OK);
        assert_eq!(read(account), ("账号".into(), 1));
        assert_eq!(put(account, json!({ "name": "账号", "shown": 0 })).await, StatusCode::OK);
        assert_eq!(read(account), ("账号".into(), 0));
        for body in [json!({ "name": "无" }), json!({ "name": "无", "shown": true })] {
            assert_eq!(put(9999, body.clone()).await, StatusCode::NOT_FOUND, "{body}");
        }
    }

    /// 字段端点与条目写入口同一分寸：选项不是数组、标记不是布尔或 0/1、ftype 不是文本、键序掺了
    /// 非文本，一律 400 且什么都不动。从前 options 传错类型会把整份词表连同颜色清成 []、回 200。
    #[tokio::test]
    async fn field_endpoints_refuse_wrong_types_and_change_nothing() {
        let (r, db) = fresh();
        let snapshot = || -> String {
            one(&db.lock().unwrap(), "SELECT group_concat(options || shown || name, '|') FROM fields", [])
        };
        let purpose_id: i64 = one(&db.lock().unwrap(), "SELECT id FROM fields WHERE tbl='vps' AND key='purpose'", []);
        let before = snapshot();
        let refused = [
            ("PUT", "/api/fields/options".to_string(), json!({ "tbl": "vps", "key": "purpose", "options": "建站" })),
            ("PUT", "/api/fields/options".to_string(), json!({ "tbl": "vps", "key": "purpose" })),
            ("PUT", "/api/fields/options".to_string(), json!({ "tbl": "vps", "key": "purpose", "options": [{ "v": "a" }, 3] })),
            ("PUT", "/api/fields/options".to_string(), json!({ "tbl": "vps", "key": "purpose", "options": [{ "v": 3 }] })),
            ("PUT", "/api/fields/semantics".to_string(),
                json!({ "tbl": "subs", "key": "status", "options": [{ "v": "Planned", "timeline": "no" }] })),
            ("PUT", "/api/fields/semantics".to_string(),
                json!({ "tbl": "subs", "key": "status", "options": [{ "v": "Planned", "timeline": 2 }] })),
            ("POST", "/api/fields".to_string(), json!({ "tbl": "subs", "name": "列", "ftype": 5 })),
            ("PUT", format!("/api/fields/{purpose_id}"), json!({ "name": "用途", "shown": "no" })),
            ("PUT", "/api/fields/order".to_string(), json!({ "tbl": "subs", "keys": ["name", 3] })),
            ("POST", "/api/fields/add_status".to_string(), json!({ "tbl": "subs", "key": "status", "value": 5 })),
        ];
        for (method, path, body) in refused {
            assert_eq!(call(&r, method, &path, Some(body.clone())).await.0, StatusCode::BAD_REQUEST, "{body}");
        }
        assert_eq!(snapshot(), before, "被拒的请求一个字段也不该写");
        // 负向对照：界面实际发的形状照常
        let ok = [
            ("PUT", "/api/fields/semantics".to_string(),
                json!({ "tbl": "subs", "key": "status", "options": [{ "v": "Planned", "timeline": 1 }] })),
            ("PUT", format!("/api/fields/{purpose_id}"), json!({ "name": "用途", "shown": false })),
            ("PUT", "/api/fields/options".to_string(), json!({ "tbl": "vps", "key": "purpose", "options": [{ "v": "建站", "c": 2 }, "代理"] })),
        ];
        for (method, path, body) in ok {
            assert_eq!(call(&r, method, &path, Some(body.clone())).await.0, StatusCode::OK, "{body}");
        }
    }

    /// 选项清单落表前先常规化：文本收成 `{v}`、去首尾空白、空值丢掉、按 v 去重留第一个、色号只认 0..9、
    /// 语义标记只在传了时落。只有 builtin=0 的 sel / multi 列能这么改，库不存在同样 400。
    #[tokio::test]
    async fn option_lists_are_normalized_before_they_are_stored() {
        let (r, db) = fresh();
        let put = |tbl: &str, key: &str, options: Value| {
            call(&r, "PUT", "/api/fields/options", Some(json!({ "tbl": tbl, "key": key, "options": options })))
        };
        let sent = json!([" a ", "", "a", { "v": "b", "c": 12 }, { "v": "c", "c": 4, "spend": 1 }, { "v": "d", "alert": false }]);
        assert_eq!(put("vps", "purpose", sent).await.0, StatusCode::OK);
        assert_eq!(
            options(&db, "vps", "purpose"),
            json!([{ "v": "a" }, { "v": "b" }, { "v": "c", "c": 4, "spend": 1 }, { "v": "d", "alert": 0 }])
        );
        // 引擎真列、没有选项的类型、不存在的库
        for (tbl, key) in [("subs", "cycle"), ("vps", "product"), ("nope", "purpose")] {
            assert_eq!(put(tbl, key, json!(["a"])).await.0, StatusCode::BAD_REQUEST, "{tbl}.{key}");
        }
    }

    /// 状态语义按值逐项合并：只动点名的那个值、只动传了的标记，别的值与没传的标记原样。
    #[tokio::test]
    async fn status_semantics_change_only_the_named_flags_of_the_named_value() {
        let (r, db) = fresh();
        let before = options(&db, "subs", "status");
        let at = before.as_array().unwrap().iter().position(|o| o["v"] == "Active").unwrap();
        assert_eq!(before[at]["alert"], 1, "前提：Active 原本发提醒");
        let sem = |key: &str| {
            call(&r, "PUT", "/api/fields/semantics", Some(json!({ "tbl": "subs", "key": key, "options": [{ "v": "Active", "alert": 0 }] })))
        };
        assert_eq!(sem("status").await.0, StatusCode::OK);
        let mut want = before.clone();
        want[at]["alert"] = json!(0);
        assert_eq!(options(&db, "subs", "status"), want);
        assert_eq!(sem("category").await.0, StatusCode::BAD_REQUEST, "没有状态词表的列");
    }

    /// 状态词表只能追加：新值三个标记全关地排到末尾；已有的值（老形态的纯文本也算）400 且词表不动。
    #[tokio::test]
    async fn the_status_vocabulary_only_grows() {
        let (r, db) = fresh();
        let mut seeded = options(&db, "subs", "status");
        seeded.as_array_mut().unwrap().push(json!("Legacy"));
        db.lock()
            .unwrap()
            .execute("UPDATE fields SET options=?1 WHERE tbl='subs' AND key='status'", [seeded.to_string()])
            .unwrap();
        let add = |value: &str| {
            call(&r, "POST", "/api/fields/add_status", Some(json!({ "tbl": "subs", "key": "status", "value": value })))
        };
        for dup in ["Active", "Legacy"] {
            assert_eq!(add(dup).await.0, StatusCode::BAD_REQUEST, "{dup}");
        }
        assert_eq!(options(&db, "subs", "status"), seeded, "被拒的请求一个字段也不该写");
        assert_eq!(add("Paused").await.0, StatusCode::OK);
        let mut want = seeded.clone();
        let list = want.as_array_mut().unwrap();
        *list.last_mut().unwrap() = json!({ "v": "Legacy" });
        list.push(json!({ "v": "Paused", "spend": 0, "alert": 0, "timeline": 0 }));
        assert_eq!(options(&db, "subs", "status"), want);
    }

    const UNTOUCHED: &str = "2000-01-01 00:00:00";

    /// 选项改名 / 删除的底子：vps 单选「用途」的词表是 [x, a(色 3)]，a 放第二位，改错了位置一眼可辨；
    /// 一行 vps 挂着 a（多选里还有重复的 a 与一个非文本元素），一行 vps 没有 a，一行 subs 挂着同名键。
    /// 各行 `updated_at` 定死在过去，回 (路由, 库, [命中行, 未命中行, 别库行])。
    fn option_fixture() -> (Router, crate::Db, [i64; 3]) {
        let (r, db) = fresh();
        let ids = {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE fields SET options=?1 WHERE tbl='vps' AND key='purpose'",
                [json!([{ "v": "x" }, { "v": "a", "c": 3 }]).to_string()],
            )
            .unwrap();
            let seed = |coll: &str, extra: Value| -> i64 {
                conn.query_row(
                    "INSERT INTO items(collection_id, name, extra, updated_at)
                     SELECT id, 'x', ?2, ?3 FROM collections WHERE key=?1 RETURNING id",
                    params![coll, extra.to_string(), UNTOUCHED],
                    |row| row.get(0),
                )
                .unwrap()
            };
            [
                seed("vps", json!({ "purpose": "a", "locations": ["x", "a", 3, "a"] })),
                seed("vps", json!({ "purpose": "x", "locations": ["x"] })),
                seed("subs", json!({ "purpose": "a" })),
            ]
        };
        (r, db, ids)
    }

    /// 一行条目的 extra 与 `updated_at`。
    fn item(db: &crate::Db, id: i64) -> (Value, String) {
        db.lock()
            .unwrap()
            .query_row("SELECT extra, updated_at FROM items WHERE id=?1", [id], |row| {
                Ok((serde_json::from_str(&row.get::<_, String>(0)?).unwrap(), row.get(1)?))
            })
            .unwrap()
    }

    /// 对单选「用途」与多选「位置」各发一次同样的请求，都要 200。
    async fn on_both_columns(r: &Router, path: &str, body: impl Fn(&str) -> Value) {
        for key in ["purpose", "locations"] {
            assert_eq!(call(r, "POST", path, Some(body(key))).await.0, StatusCode::OK, "{key}");
        }
    }

    /// 选项改名在词表里原位进行、带着颜色走，并传到这个库里每一行挂着它的值：单选整值换掉；多选按集合改，
    /// 重复的旧值并成一个、不是文本的元素原样留着。没挂这个值的行与别的库一个字节都不动。
    #[tokio::test]
    async fn renaming_an_option_carries_its_color_and_reaches_every_row() {
        let (r, db, [hit, miss, other]) = option_fixture();
        let untouched = (item(&db, miss), item(&db, other));
        on_both_columns(&r, "/api/fields/rename_option", |key| json!({ "tbl": "vps", "key": key, "from": "a", "to": "b" })).await;
        assert_eq!(options(&db, "vps", "purpose"), json!([{ "v": "x" }, { "v": "b", "c": 3 }]));
        let (extra, updated) = item(&db, hit);
        assert_eq!(extra, json!({ "purpose": "b", "locations": ["x", "b", 3] }));
        assert_ne!(updated, UNTOUCHED);
        assert_eq!((item(&db, miss), item(&db, other)), untouched);
    }

    /// 改成一个已有的选项就是合并：被改名的那项连同颜色从词表里消失，单选行改指已有的那项，多选行里两者并成一个。
    #[tokio::test]
    async fn renaming_onto_an_existing_option_merges_the_two() {
        let (r, db, [hit, ..]) = option_fixture();
        on_both_columns(&r, "/api/fields/rename_option", |key| json!({ "tbl": "vps", "key": key, "from": "a", "to": "x" })).await;
        assert_eq!(options(&db, "vps", "purpose"), json!([{ "v": "x" }]));
        assert_eq!(item(&db, hit).0, json!({ "purpose": "x", "locations": ["x", 3] }));
    }

    /// 改成自己是空操作，词表与各行原样：走合并那条路的话，这一项会被当成重复删掉。
    #[tokio::test]
    async fn renaming_an_option_to_itself_changes_nothing() {
        let (r, db, [hit, ..]) = option_fixture();
        let before = (options(&db, "vps", "purpose"), item(&db, hit));
        on_both_columns(&r, "/api/fields/rename_option", |key| json!({ "tbl": "vps", "key": key, "from": "a", "to": "a" })).await;
        assert_eq!((options(&db, "vps", "purpose"), item(&db, hit)), before);
    }

    /// 删选项：移出词表，并从这个库每一行清掉——单选连键删掉，多选只摘这个值；别的行与别的库不动。
    #[tokio::test]
    async fn removing_an_option_clears_it_from_every_row() {
        let (r, db, [hit, miss, other]) = option_fixture();
        let untouched = (item(&db, miss), item(&db, other));
        on_both_columns(&r, "/api/fields/remove_option", |key| json!({ "tbl": "vps", "key": key, "value": "a" })).await;
        assert_eq!(options(&db, "vps", "purpose"), json!([{ "v": "x" }]));
        assert_eq!(item(&db, hit).0, json!({ "locations": ["x", 3] }));
        assert_eq!((item(&db, miss), item(&db, other)), untouched);
    }
}
