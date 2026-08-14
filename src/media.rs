use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Json, Router,
};
use rusqlite::{params, types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::api::{bad, f, i, missing, s, ApiError, R};
use crate::{db, tmdb, App};

const STR_FIELDS: &[&str] = &[
    "kind", "title", "orig_title", "status", "marked_at", "started_at", "review",
    "others_reviews", "genres", "directors", "writers", "actors", "countries", "languages",
    "runtime", "release_date", "douban_id", "douban_url", "imdb_id", "platform", "cover", "notes",
];
const INT_FIELDS: &[&str] = &["year", "rating", "douban_votes", "tmdb_id", "steam_appid"];
const REAL_FIELDS: &[&str] = &["douban_rating", "playtime_hours"];

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/media", get(list).post(create))
        .route("/api/media/order", put(set_order))
        .route("/api/media/bulk_delete", post(bulk_delete))
        // 与库那侧同：条目更新是 PATCH（局部更新，缺席即保持）
        .route("/api/media/{id}", patch(update).delete(delete))
        .route("/api/media/import", post(import))
        .route("/api/media/from_tmdb", post(from_tmdb))
        .route("/api/media/{id}/fetch_cover", post(fetch_cover))
        .route("/api/tmdb/search", get(tmdb_search))
        .route("/api/tmdb/thumb", get(tmdb_thumb))
        .route("/covers/{name}", get(cover_file))
}

fn normalized(conn: &Connection, mut b: Value) -> Result<Value, ApiError> {
    // 空标题是允许的：表尾「＋ 新建」直接插一行空行、就地填（与库那侧同款）。
    // title 有 NOT NULL 约束，所以 values_of 会把它写成空串而不是 NULL。
    // 评分越界会一路渲染到界面上（99 星把整行撑爆）；不填＝没评分，那是允许的
    if let Some(r) = i(&b, "rating") {
        if !(1..=5).contains(&r) {
            return Err(bad("评分只能是 1–5 星").into());
        }
    }
    if s(&b, "kind").is_none() {
        b["kind"] = json!("电影");
    }
    if s(&b, "status").is_none() {
        b["status"] = json!("想看");
    }
    // 有形状的字段（tel/url/email）与库那侧同一套规范化：媒体的自定义列也能选这三种
    // 类型（"新建列"的类型下拉对两侧一视同仁），写入口不过一遍的话「网址」列存进去的
    // 就是没有协议的裸串，渲染成链接时会被当成站内相对路径
    crate::collections::normalize_shaped_in(conn, "media", &mut b)?;
    Ok(b)
}

fn values_of(b: &Value) -> (Vec<&'static str>, Vec<SqlValue>) {
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for k in STR_FIELDS {
        cols.push(*k);
        vals.push(if *k == "title" {
            SqlValue::from(s(b, k).unwrap_or_default()) // NOT NULL：空标题写空串
        } else {
            s(b, k).map(SqlValue::from).unwrap_or(SqlValue::Null)
        });
    }
    for k in INT_FIELDS {
        cols.push(*k);
        vals.push(i(b, k).map(SqlValue::from).unwrap_or(SqlValue::Null));
    }
    for k in REAL_FIELDS {
        cols.push(*k);
        vals.push(f(b, k).map(SqlValue::from).unwrap_or(SqlValue::Null));
    }
    cols.push("extra");
    vals.push(crate::api::extra_str(b).map(SqlValue::from).unwrap_or(SqlValue::Null));
    (cols, vals)
}

fn insert(conn: &Connection, b: &Value) -> anyhow::Result<i64> {
    let (mut cols, mut vals) = values_of(b);
    // 新行落在手动序末尾。pos 只在这里和 /api/media/order 两处写，整行 PUT 碰不到它
    //（values_of 只铺 STR/INT/REAL 三张表里的列，pos 不在其中）。
    cols.push("pos");
    vals.push(SqlValue::from(conn.query_row(
        "SELECT COALESCE(MAX(pos),0)+1 FROM media_items",
        [],
        |r| r.get::<_, i64>(0),
    )?));
    let placeholders: Vec<String> = (1..=cols.len()).map(|n| format!("?{n}")).collect();
    conn.execute(
        &format!(
            "INSERT INTO media_items({}) VALUES({})",
            cols.join(","),
            placeholders.join(",")
        ),
        rusqlite::params_from_iter(vals),
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_json(row: &rusqlite::Row, cols: &[String]) -> rusqlite::Result<Value> {
    let mut obj = Map::new();
    for (idx, c) in cols.iter().enumerate() {
        let v = match row.get_ref(idx)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(n) => Value::from(n),
            rusqlite::types::ValueRef::Real(x) => Value::from(x),
            rusqlite::types::ValueRef::Text(t) => {
                let text = String::from_utf8_lossy(t).into_owned();
                if c == "extra" {
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

async fn list(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> R {
    let conn = app.db.lock().unwrap();
    let mut sql = String::from("SELECT * FROM media_items");
    let mut conds: Vec<String> = Vec::new();
    let mut binds: Vec<String> = Vec::new();
    if let Some(k) = q.get("kind").filter(|v| !v.is_empty() && *v != "全部") {
        binds.push(k.clone());
        conds.push(format!("kind=?{}", binds.len()));
    }
    if let Some(st) = q.get("status").filter(|v| !v.is_empty() && *v != "全部") {
        binds.push(st.clone());
        conds.push(format!("status=?{}", binds.len()));
    }
    if let Some(text) = q.get("q").map(|v| v.trim()).filter(|v| !v.is_empty()) {
        // % 与 _ 是 LIKE 的通配符：不转义的话搜「100%」等于搜「以 100 开头的一切」
        let pat = text.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_");
        binds.push(format!("%{pat}%"));
        let n = binds.len();
        let cols = ["title", "orig_title", "review", "directors", "actors"];
        conds.push(format!(
            "({})",
            cols.map(|c| format!(r"{c} LIKE ?{n} ESCAPE '\'")).join(" OR ")
        ));
    }
    if !conds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conds.join(" AND "));
    }
    sql.push_str(" ORDER BY marked_at IS NULL, marked_at DESC, id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let cols: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let rows: Vec<Value> = stmt
        .query_map(rusqlite::params_from_iter(binds.iter()), |r| {
            row_to_json(r, &cols)
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Json(json!(rows)))
}

async fn create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let b = normalized(&conn, b)?;
    let id = insert(&conn, &b)?;
    Ok(Json(json!({ "id": id })))
}

/// 局部更新：请求里出现的键写入（`""`/`null` 即清空），缺席的键保持原值，
/// `extra` 作为整体走同一条规则。与库那侧同一套语义（`collections::merge_over`）——
/// 曾经是全量替换，于是"开一次详情表单直接保存"就能把自定义列整片清掉。
async fn update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let cur: Value = conn
        .query_row("SELECT * FROM media_items WHERE id=?1", [id], |r| {
            let cols: Vec<String> = r.as_ref().column_names().iter().map(|c| c.to_string()).collect();
            row_to_json(r, &cols)
        })
        .map_err(|_| missing("条目不存在"))?;
    let writable = STR_FIELDS
        .iter()
        .chain(INT_FIELDS)
        .chain(REAL_FIELDS)
        .copied()
        .chain(std::iter::once("extra"));
    let b = crate::collections::merge_over(&cur, &b, writable);
    let b = normalized(&conn, b)?;
    let (cols, mut vals) = values_of(&b);
    let sets: Vec<String> = cols
        .iter()
        .enumerate()
        .map(|(idx, c)| format!("{c}=?{}", idx + 1))
        .collect();
    vals.push(SqlValue::from(id));
    let n = conn.execute(
        &format!(
            "UPDATE media_items SET {},updated_at=datetime('now') WHERE id=?{}",
            sets.join(","),
            cols.len() + 1
        ),
        rusqlite::params_from_iter(vals),
    )?;
    if n == 0 {
        return Err(missing("条目不存在").into());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let conn = app.db.lock().unwrap();
    // 海报文件跟着条目走，否则 covers/ 里会永久留下孤儿（条目 logo 早就是这么处理的）
    let cover: Option<String> = conn
        .query_row("SELECT cover FROM media_items WHERE id=?1", [id], |r| r.get(0))
        .unwrap_or(None);
    conn.execute("DELETE FROM media_items WHERE id=?1", [id])?;
    if let Some(n) = cover.filter(|n| crate::api::safe_name(n)) {
        let _ = std::fs::remove_file(app.data_dir.join("covers").join(n));
    }
    Ok(Json(json!({ "ok": true })))
}

/// 整份手动序：收到的是当前的完整行序，按下标落 pos。
async fn set_order(State(app): State<App>, Json(b): Json<Value>) -> R {
    let ids = crate::collections::id_list(&b)?;
    let conn = app.db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    for (n, id) in ids.iter().enumerate() {
        tx.execute("UPDATE media_items SET pos=?1 WHERE id=?2", params![n as i64 + 1, id])?;
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

/// 批量删除。整批一个事务，海报文件在提交之后才清（回滚了就不会留孤儿）。
async fn bulk_delete(State(app): State<App>, Json(b): Json<Value>) -> R {
    let ids = crate::collections::id_list(&b)?;
    let conn = app.db.lock().unwrap();
    let mut covers = Vec::new();
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        let cover: Option<String> = tx
            .query_row("SELECT cover FROM media_items WHERE id=?1", [id], |r| r.get(0))
            .unwrap_or(None);
        covers.push(cover);
        tx.execute("DELETE FROM media_items WHERE id=?1", [id])?;
    }
    tx.commit()?;
    for name in covers.into_iter().flatten().filter(|n| crate::api::safe_name(n)) {
        let _ = std::fs::remove_file(app.data_dir.join("covers").join(name));
    }
    Ok(Json(json!({ "ok": true, "deleted": ids.len() })))
}

/// 批量导入（Notion 迁移 / 豆伴 CSV 适配器共用）：douban_id 或 (title,year,kind) 已存在则跳过。
async fn import(State(app): State<App>, Json(b): Json<Value>) -> R {
    let items = b.as_array().ok_or_else(|| bad("需要数组"))?;
    let conn = app.db.lock().unwrap();
    let (mut added, mut skipped, mut failed) = (0, 0, 0);
    for raw in items {
        let Ok(item) = normalized(&conn, raw.clone()) else {
            failed += 1;
            continue;
        };
        let dup = if let Some(did) = s(&item, "douban_id") {
            conn.query_row(
                "SELECT 1 FROM media_items WHERE douban_id=?1 LIMIT 1",
                params![did],
                |_| Ok(()),
            )
            .is_ok()
        } else {
            conn.query_row(
                "SELECT 1 FROM media_items WHERE title=?1 AND ifnull(year,0)=ifnull(?2,0) AND kind=?3 LIMIT 1",
                params![s(&item, "title"), i(&item, "year"), s(&item, "kind")],
                |_| Ok(()),
            )
            .is_ok()
        };
        if dup {
            skipped += 1;
        } else if insert(&conn, &item).is_ok() {
            added += 1;
        } else {
            failed += 1;
        }
    }
    Ok(Json(json!({ "added": added, "skipped": skipped, "failed": failed })))
}

fn meta_cfg(conn: &Connection) -> (String, String) {
    (
        db::get_setting(conn, "meta.tmdb_key").unwrap_or_default(),
        db::get_setting(conn, "meta.proxy").unwrap_or_default(),
    )
}

async fn tmdb_search(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> R {
    let text = q.get("q").map(|v| v.trim()).filter(|v| !v.is_empty())
        .ok_or_else(|| bad("缺少搜索词"))?
        .to_string();
    let tv = matches!(q.get("kind").map(String::as_str), Some("剧集" | "动画"));
    let (key, proxy) = {
        let conn = app.db.lock().unwrap();
        meta_cfg(&conn)
    };
    let client = tmdb::Tmdb::new(&key, &proxy)?;
    Ok(Json(json!(client.search(tv, &text).await?)))
}

/// 搜索结果里的小图。转发而不是让浏览器直连 image.tmdb.org——直连绕开 `meta.proxy`
/// （被墙环境配了代理也全是空图），也是「出网只从服务端走」的唯一破口。
async fn tmdb_thumb(
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let path = q.get("path").map(String::as_str).unwrap_or_default();
    if !tmdb::image_path_ok(path) {
        return Err(bad("图片路径不合法").into());
    }
    let (key, proxy) = {
        let conn = app.db.lock().unwrap();
        meta_cfg(&conn)
    };
    let client = tmdb::Tmdb::new(&key, &proxy)?;
    let bytes = client.image("w92", path).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

/// 选中 TMDB 条目 → 建档 + 海报本地化，返回新条目 id。
async fn from_tmdb(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tmdb_id = i(&b, "tmdb_id").ok_or_else(|| bad("缺少 tmdb_id"))?;
    let kind = s(&b, "kind").unwrap_or_else(|| "电影".into());
    let tv = matches!(kind.as_str(), "剧集" | "动画");
    let (key, proxy) = {
        let conn = app.db.lock().unwrap();
        meta_cfg(&conn)
    };
    let client = tmdb::Tmdb::new(&key, &proxy)?;
    let (mut fields, poster) = client.details(tv, tmdb_id).await?;
    fields["kind"] = json!(kind);
    fields["status"] = json!(s(&b, "status").unwrap_or_else(|| "想看".into()));
    let id = {
        let conn = app.db.lock().unwrap();
        insert(&conn, &normalized(&conn, fields)?)?
    };
    if let Some(p) = poster {
        match client.poster(&p).await {
            Ok(bytes) => {
                let dir = app.data_dir.join("covers");
                std::fs::create_dir_all(&dir)?;
                let name = format!("{id}.jpg");
                std::fs::write(dir.join(&name), bytes)?;
                let conn = app.db.lock().unwrap();
                conn.execute(
                    "UPDATE media_items SET cover=?1 WHERE id=?2",
                    params![name, id],
                )?;
            }
            Err(e) => tracing::warn!("poster download failed for {id}: {e:#}"),
        }
    }
    Ok(Json(json!({ "id": id })))
}

/// 去掉"第N季"式后缀，剧集每季一条时用底本剧名去 TMDB 搜索。
fn base_title(t: &str) -> &str {
    let t = t.trim();
    if t.ends_with('季') {
        if let Some(pos) = t.rfind('第') {
            return t[..pos].trim();
        }
    }
    t
}

/// 为已有条目补抓海报：有 tmdb_id 直接取详情，否则按标题（年份差 ≤1 优先）搜索匹配。
async fn fetch_cover(State(app): State<App>, Path(id): Path<i64>) -> R {
    let (kind, title, orig_title, year, tmdb_id, key, proxy) = {
        let conn = app.db.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT kind,title,ifnull(orig_title,''),year,tmdb_id FROM media_items WHERE id=?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                        r.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .map_err(|_| missing("条目不存在"))?;
        let (key, proxy) = meta_cfg(&conn);
        (row.0, row.1, row.2, row.3, row.4, key, proxy)
    };
    if kind == "游戏" {
        return Err(bad("游戏封面暂不支持（后续接 IGDB）").into());
    }
    let tv = matches!(kind.as_str(), "剧集" | "动画");
    let client = tmdb::Tmdb::new(&key, &proxy)?;
    let found = match tmdb_id {
        Some(t) => t,
        None => {
            let mut hits = client.search(tv, base_title(&title)).await?;
            if hits.is_empty() && !orig_title.is_empty() {
                hits = client.search(tv, base_title(&orig_title)).await?;
            }
            let pick = hits
                .iter()
                .find(|h| matches!((year, h["year"].as_i64()), (Some(y), Some(hy)) if (y - hy).abs() <= 1))
                .or_else(|| hits.first())
                .ok_or_else(|| bad(format!("TMDB 无匹配：{title}")))?;
            pick["tmdb_id"].as_i64().ok_or_else(|| bad("TMDB 结果异常"))?
        }
    };
    let (_, poster) = client.details(tv, found).await?;
    let p = poster.ok_or_else(|| bad(format!("TMDB 该条目没有海报：{title}")))?;
    let bytes = client.poster(&p).await?;
    let dir = app.data_dir.join("covers");
    std::fs::create_dir_all(&dir)?;
    let name = format!("{id}.jpg");
    std::fs::write(dir.join(&name), bytes)?;
    {
        let conn = app.db.lock().unwrap();
        conn.execute(
            "UPDATE media_items SET cover=?1, tmdb_id=ifnull(tmdb_id,?2), updated_at=datetime('now') WHERE id=?3",
            params![name, found, id],
        )?;
    }
    Ok(Json(json!({ "ok": true, "cover": name, "tmdb_id": found })))
}

async fn cover_file(
    State(app): State<App>,
    Path(name): Path<String>,
) -> Result<Response, ApiError> {
    if !crate::api::safe_name(&name) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let path = app.data_dir.join("covers").join(&name);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=604800"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
