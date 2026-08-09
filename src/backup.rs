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
    "media_items",
    "fields",
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
    // 顺手扫掉上一次被硬杀留下的半截快照
    for entry in fs::read_dir(&backups)?.flatten() {
        let p = entry.path();
        let looks_ours = p
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("snapshot-"));
        if looks_ours && p.extension().is_some_and(|x| x == "tmp") {
            let _ = fs::remove_file(&p);
        }
    }
    // **先写 .tmp 再改名。** 判断「今天备过了吗」看的就是正式名那个文件在不在，而
    // `VACUUM INTO` 是直写目标路径的：中途失败（磁盘满）或被 SIGKILL（docker stop 宽限期
    // 到点升级）都会留下一份半截快照占着正式名——当天备份从此静默跳过，这份坏快照还会
    // 进保留 N 份的轮转。rename 是原子的，只有写完的快照才拿得到正式名（与 JSONL 导出同法）。
    // 已存在的正式快照**不要先删**：rename 本就会原地覆盖，先删了再 VACUUM 失败，
    // 赔上的是今天那份本来还好好的快照（手动重跑备份走的正是这条路）
    let snapshot = backups.join(format!("snapshot-{}.db", crate::engine::today()));
    let tmp = snapshot.with_extension("db.tmp");
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])?;
    fs::rename(&tmp, &snapshot)?;

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
        // 先写临时文件再改名：原地写崩在半途留下的是一份看着像样、实则截断的导出
        let out = export_dir.join(format!("{table}.jsonl"));
        let tmp = out.with_extension("jsonl.tmp");
        fs::write(&tmp, lines)?;
        fs::rename(&tmp, &out)?;
    }

    let mut snaps: Vec<PathBuf> = fs::read_dir(&backups)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("snapshot-"))
                && p.extension().is_some_and(|x| x == "db")
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
                // 这里曾经在失败时删掉今日快照，因为半截快照会让备份从此静默停摆。
                // 现在快照走 .tmp + rename，失败路径根本产不出正式名的文件，反倒是
                // 「快照已写好、后面的 JSONL 导出才失败」时删它等于毁掉一份好快照
                Err(e) => tracing::warn!("backup failed: {e:#}"),
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
    }
}
