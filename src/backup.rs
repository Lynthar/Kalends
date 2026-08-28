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

/* ── 恢复：把快照装配成一个全新数据目录并当场验证 ─────────────────── */

#[derive(Debug)]
pub struct RestoreReport {
    pub user_version: i64,
    pub pending: i64,
    pub assets_from: Option<PathBuf>,
    pub assets_copied: usize,
    pub missing: Vec<String>,
    pub orphans: usize,
}

/// `to` 必须不存在或为空目录：恢复只装配新目录，绝不覆盖在用数据。
/// 验证三件事：integrity_check（含外键）、user_version 不高于本二进制、covers/logos 引用在位；
/// 快照在标准 `<数据目录>/backups/` 布局里时，顺带从原数据目录把 covers/logos 复制过来。
pub fn restore(from: &Path, to: &Path) -> Result<RestoreReport> {
    if !from.is_file() {
        anyhow::bail!("快照不存在：{}", from.display());
    }
    if let Ok(mut entries) = fs::read_dir(to) {
        if entries.next().is_some() {
            anyhow::bail!("目标目录非空：{}（恢复只装配全新目录，不覆盖既有数据）", to.display());
        }
    } else {
        fs::create_dir_all(to)?;
    }
    fs::copy(from, to.join("kalends.db"))?;

    let conn = Connection::open_with_flags(
        to.join("kalends.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let verdict: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if verdict != "ok" {
        anyhow::bail!("integrity_check 未通过（{verdict}）：这份快照已损坏，换更早的一份");
    }
    let mut fk = conn.prepare("PRAGMA foreign_key_check")?;
    if fk.query([])?.next()?.is_some() {
        anyhow::bail!("foreign_key_check 未通过：这份快照里有悬空外键，换更早的一份");
    }
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let known = crate::db::known_version();
    if user_version > known {
        anyhow::bail!("快照的 user_version {user_version} 高于本二进制支持的 {known}：用更新版本的 Kalends 来恢复");
    }

    // 图标不在快照里：按标准布局回到原数据目录整份带上（含孤儿，恢复求忠实不做清理）
    let assets_from = from
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "backups"))
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    let mut assets_copied = 0usize;
    if let Some(src) = &assets_from {
        if let Ok(entries) = fs::read_dir(src.join("logos")) {
            fs::create_dir_all(to.join("logos"))?;
            for entry in entries.flatten() {
                if entry.path().is_file() {
                    fs::copy(entry.path(), to.join("logos").join(entry.file_name()))?;
                    assets_copied += 1;
                }
            }
        }
    }

    // 引用核对：条目引用而磁盘缺失的按缺失报；名字不过 safe_name 的本就永远服务不出来，同报
    let mut referenced = Vec::new();
    if table_exists(&conn, "items") {
        // 老快照可能还没这张表，缺表不等于缺文件
        let mut stmt =
            conn.prepare("SELECT logo FROM items WHERE logo IS NOT NULL AND logo != ''")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for name in names {
            referenced.push(name?);
        }
    }
    let mut missing = std::collections::BTreeSet::new();
    let mut present = std::collections::HashSet::new();
    for name in &referenced {
        if crate::api::safe_name(name) && to.join("logos").join(name).is_file() {
            present.insert(name.clone());
        } else {
            missing.insert(format!("logos/{name}"));
        }
    }
    let mut orphans = 0usize;
    if let Ok(entries) = fs::read_dir(to.join("logos")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_file() && !present.contains(&name) {
                orphans += 1;
            }
        }
    }
    Ok(RestoreReport {
        user_version,
        pending: known - user_version,
        assets_from,
        assets_copied,
        missing: missing.into_iter().collect(),
        orphans,
    })
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// 恢复演练全流程：备份产出的快照装配成新目录，logos/ 整份带上、引用核对通过；
    /// 负向对照：源目录里被引用的文件消失后，恢复必须点名它。
    #[test]
    fn a_snapshot_restores_into_a_verified_new_data_dir() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("data");
        let conn = crate::db::open(&src).unwrap();
        conn.execute(
            "INSERT INTO items(collection_id,name,logo)
             VALUES((SELECT id FROM collections WHERE key='subs'),'Example','a.png')",
            [],
        )
        .unwrap();
        fs::create_dir_all(src.join("logos")).unwrap();
        fs::write(src.join("logos").join("a.png"), b"x").unwrap();
        fs::write(src.join("logos").join("orphan.png"), b"x").unwrap();
        let snapshot = run(&conn, &src).unwrap().snapshot;
        drop(conn);

        let to = root.path().join("restored");
        let r = restore(&snapshot, &to).unwrap();
        assert!(r.missing.is_empty(), "{:?}", r.missing);
        assert_eq!((r.pending, r.assets_copied, r.orphans), (0, 2, 1));
        assert_eq!(r.assets_from.as_deref(), Some(src.as_path()));
        let restored = Connection::open(to.join("kalends.db")).unwrap();
        assert_eq!(one::<i64>(&restored, "SELECT count(*) FROM items"), 1);

        fs::remove_file(src.join("logos").join("a.png")).unwrap();
        let r = restore(&snapshot, &root.path().join("restored2")).unwrap();
        assert_eq!(r.missing, ["logos/a.png"]);
    }

    /// 挡得住的三种坏输入：非空目标（防覆盖在用数据）、根本不是数据库的文件、未来版本的快照。
    #[test]
    fn restore_refuses_bad_targets_and_bad_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("data");
        let conn = crate::db::open(&src).unwrap();
        let snapshot = run(&conn, &src).unwrap().snapshot;
        drop(conn);

        let busy = root.path().join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("x"), b"x").unwrap();
        let err = restore(&snapshot, &busy).unwrap_err().to_string();
        assert!(err.contains("非空"), "{err}");

        let garbage = root.path().join("garbage.db");
        fs::write(&garbage, b"not a database").unwrap();
        assert!(restore(&garbage, &root.path().join("g")).is_err());

        let newer = root.path().join("newer.db");
        fs::copy(&snapshot, &newer).unwrap();
        Connection::open(&newer)
            .unwrap()
            .pragma_update(None, "user_version", crate::db::known_version() + 1)
            .unwrap();
        let err = restore(&newer, &root.path().join("n")).unwrap_err().to_string();
        assert!(err.contains("高于本二进制"), "{err}");
    }
}
