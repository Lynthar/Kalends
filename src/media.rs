use anyhow::anyhow;
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::api::{f, i, s, ApiError, R};
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
        .route("/api/media/{id}", put(update).delete(delete))
        .route("/api/media/import", post(import))
        .route("/api/media/from_tmdb", post(from_tmdb))
        .route("/api/media/{id}/fetch_cover", post(fetch_cover))
        .route("/api/tmdb/search", get(tmdb_search))
        .route("/covers/{name}", get(cover_file))
}

fn normalized(mut b: Value) -> Result<Value, ApiError> {
    if s(&b, "title").is_none() {
        return Err(anyhow!("标题不能为空").into());
    }
    if s(&b, "kind").is_none() {
        b["kind"] = json!("电影");
    }
    if s(&b, "status").is_none() {
        b["status"] = json!("想看");
    }
    Ok(b)
}

fn values_of(b: &Value) -> (Vec<&'static str>, Vec<SqlValue>) {
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for k in STR_FIELDS {
        cols.push(*k);
        vals.push(s(b, k).map(SqlValue::from).unwrap_or(SqlValue::Null));
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
    let (cols, vals) = values_of(b);
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
        binds.push(format!("%{text}%"));
        let n = binds.len();
        conds.push(format!(
            "(title LIKE ?{n} OR orig_title LIKE ?{n} OR review LIKE ?{n} OR directors LIKE ?{n} OR actors LIKE ?{n})"
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
    let b = normalized(b)?;
    let conn = app.db.lock().unwrap();
    let id = insert(&conn, &b)?;
    Ok(Json(json!({ "id": id })))
}

async fn update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let b = normalized(b)?;
    let conn = app.db.lock().unwrap();
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
        return Err(anyhow!("条目不存在").into());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let conn = app.db.lock().unwrap();
    conn.execute("DELETE FROM media_items WHERE id=?1", [id])?;
    Ok(Json(json!({ "ok": true })))
}

/// 批量导入（Notion 迁移 / 豆伴 CSV 适配器共用）：douban_id 或 (title,year,kind) 已存在则跳过。
async fn import(State(app): State<App>, Json(b): Json<Value>) -> R {
    let items = b.as_array().ok_or_else(|| anyhow!("需要数组"))?;
    let conn = app.db.lock().unwrap();
    let (mut added, mut skipped, mut failed) = (0, 0, 0);
    for raw in items {
        let Ok(item) = normalized(raw.clone()) else {
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
        .ok_or_else(|| anyhow!("缺少搜索词"))?
        .to_string();
    let tv = matches!(q.get("kind").map(String::as_str), Some("剧集" | "动画"));
    let (key, proxy) = {
        let conn = app.db.lock().unwrap();
        meta_cfg(&conn)
    };
    let client = tmdb::Tmdb::new(&key, &proxy)?;
    Ok(Json(json!(client.search(tv, &text).await?)))
}

/// 选中 TMDB 条目 → 建档 + 海报本地化，返回新条目 id。
async fn from_tmdb(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tmdb_id = i(&b, "tmdb_id").ok_or_else(|| anyhow!("缺少 tmdb_id"))?;
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
        insert(&conn, &normalized(fields)?)?
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
            .map_err(|_| anyhow!("条目不存在"))?;
        let (key, proxy) = meta_cfg(&conn);
        (row.0, row.1, row.2, row.3, row.4, key, proxy)
    };
    if kind == "游戏" {
        return Err(anyhow!("游戏封面暂不支持（后续接 IGDB）").into());
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
                .ok_or_else(|| anyhow!("TMDB 无匹配：{title}"))?;
            pick["tmdb_id"].as_i64().ok_or_else(|| anyhow!("TMDB 结果异常"))?
        }
    };
    let (_, poster) = client.details(tv, found).await?;
    let p = poster.ok_or_else(|| anyhow!("TMDB 该条目没有海报：{title}"))?;
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
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
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
        ],
        bytes,
    )
        .into_response())
}
