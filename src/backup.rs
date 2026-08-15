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
    // **先写 .tmp 再改名**："今天备过了吗"看的就是正式名在不在，而 VACUUM INTO 直写
    // 目标路径——半途死掉会留半截快照占着正式名，当天备份从此静默跳过。已存在的正式
    // 快照不要先删：rename 本就原地覆盖，先删了再失败，赔上的是今天那份好快照。
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

/// 今天的 JSONL 导出是否写好（按序逐张写，最后那张新鲜＝整轮走完）。补跑判据必须
/// 带上它——只看快照的话，"快照成了、导出才失败"这一路当天不再重试，
/// 留下一份停在昨天的明文导出。
fn exported_today(data_dir: &Path) -> bool {
    let last = TABLES[TABLES.len() - 1];
    let Ok(meta) = fs::metadata(data_dir.join("export").join(format!("{last}.jsonl"))) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else { return false };
    chrono::DateTime::<chrono::Local>::from(mtime).date_naive() == crate::engine::today()
}

/// 每半小时醒来：过了 03:30 且今日快照或今日导出缺失就补跑（重启后自动补上当天的份）。
pub async fn scheduler(db: crate::Db, data_dir: PathBuf) {
    loop {
        let now_hhmm = chrono::Local::now().format("%H:%M").to_string();
        let today_snap = data_dir
            .join("backups")
            .join(format!("snapshot-{}.db", crate::engine::today()));
        if now_hhmm.as_str() >= RUN_AFTER && (!today_snap.exists() || !exported_today(&data_dir)) {
            let result = {
                let conn = db.lock().unwrap();
                run(&conn, &data_dir)
            };
            match result {
                Ok(r) => tracing::info!("backup done: {}", r.snapshot.display()),
                // 失败时不删今日快照：失败路径产不出正式名的文件（.tmp + rename），
                // 而"快照已写好、导出才失败"时删它等于毁掉一份好快照
                Err(e) => tracing::warn!("backup failed: {e:#}"),
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
    }
}
