use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;
use rusqlite::{types::ValueRef, Connection};
use serde_json::{Map, Value};

const TABLES: &[&str] = &[
    "collections",
    "items",
    // 旧三表在库泛化后只作回滚兜底，仍一并导出，等确认无需回退再从这里摘掉
    "subscriptions",
    "sim_cards",
    "vps_instances",
    "media_items",
    "fields",
    "price_history",
    "renewal_ledger",
    "notification_log",
    "settings",
];
const KEEP_SNAPSHOTS: usize = 14;
const RUN_AFTER: &str = "03:30";

pub struct Report {
    pub snapshot: PathBuf,
    pub export_dir: PathBuf,
    pub removed: usize,
}

/// 快照（VACUUM INTO，按日期一份、保留最近 N 份）+ 全表 JSONL 明文导出（最新一份，覆盖）。
pub fn run(conn: &Connection, data_dir: &Path) -> Result<Report> {
    let backups = data_dir.join("backups");
    fs::create_dir_all(&backups)?;
    let snapshot = backups.join(format!("snapshot-{}.db", crate::engine::today()));
    if snapshot.exists() {
        fs::remove_file(&snapshot)?;
    }
    conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])?;

    let export_dir = data_dir.join("export");
    fs::create_dir_all(&export_dir)?;
    for table in TABLES {
        let mut stmt = conn.prepare(&format!("SELECT * FROM {table}"))?;
        let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut lines = String::new();
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let mut obj = Map::new();
            for (idx, col) in cols.iter().enumerate() {
                let v = match row.get_ref(idx)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => Value::from(n),
                    ValueRef::Real(f) => Value::from(f),
                    ValueRef::Text(s) => Value::from(String::from_utf8_lossy(s).into_owned()),
                    ValueRef::Blob(b) => Value::from(format!("<blob {} B>", b.len())),
                };
                obj.insert(col.clone(), v);
            }
            lines.push_str(&serde_json::to_string(&obj)?);
            lines.push('\n');
        }
        fs::write(export_dir.join(format!("{table}.jsonl")), lines)?;
    }

    let mut snaps: Vec<PathBuf> = fs::read_dir(&backups)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .map_or(false, |n| n.to_string_lossy().starts_with("snapshot-"))
        })
        .collect();
    snaps.sort();
    let mut removed = 0;
    while snaps.len() > KEEP_SNAPSHOTS {
        fs::remove_file(snaps.remove(0))?;
        removed += 1;
    }
    Ok(Report {
        snapshot,
        export_dir,
        removed,
    })
}

/// 每半小时醒来：过了 03:30 且今日快照缺失就补跑（重启后自动补上当天的份）。
pub async fn scheduler(db: crate::Db, data_dir: PathBuf) {
    loop {
        let now_hhmm = chrono::Local::now().format("%H:%M").to_string();
        let today_snap = data_dir
            .join("backups")
            .join(format!("snapshot-{}.db", crate::engine::today()));
        if now_hhmm.as_str() >= RUN_AFTER && !today_snap.exists() {
            let result = {
                let conn = db.lock().unwrap();
                run(&conn, &data_dir)
            };
            match result {
                Ok(r) => tracing::info!("backup done: {}", r.snapshot.display()),
                Err(e) => tracing::warn!("backup failed: {e:#}"),
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
    }
}
