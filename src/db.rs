use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_renewal_center.sql"),
    include_str!("../migrations/0002_media.sql"),
    include_str!("../migrations/0003_vps.sql"),
    include_str!("../migrations/0004_fields.sql"),
    include_str!("../migrations/0005_sub_logo.sql"),
    include_str!("../migrations/0006_status_en.sql"),
    include_str!("../migrations/0007_collections.sql"),
    include_str!("../migrations/0008_field_registry.sql"),
    include_str!("../migrations/0009_coll_subline.sql"),
    include_str!("../migrations/0010_drop_price_history.sql"),
    include_str!("../migrations/0011_drop_legacy_tables.sql"),
    include_str!("../migrations/0012_manual_order.sql"),
    include_str!("../migrations/0013_merge_currency_into_price.sql"),
    include_str!("../migrations/0014_builtin_domain_fields.sql"),
    include_str!("../migrations/0015_phone_is_a_tel_field.sql"),
    include_str!("../migrations/0016_spec_shows_port_and_traffic.sql"),
    include_str!("../migrations/0017_split_renew_from_due_anchor.sql"),
    include_str!("../migrations/0018_ledger_keeps_its_own_names.sql"),
    include_str!("../migrations/0019_rating_out_of_ten.sql"),
];

/// 一个跑完全部迁移的内存库，等价于"全新安装"。只给测试用。
#[cfg(test)]
pub fn fresh_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open(data_dir: &Path) -> Result<Connection> {
    std::fs::create_dir_all(data_dir)?;
    let conn = Connection::open(data_dir.join("kalends.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .ok()
}

/// 首次启动播种默认设置（已存在的键不覆盖）。
pub fn seed_defaults(conn: &Connection) -> Result<()> {
    let ics_token: String =
        conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
    let defaults: [(&str, String); 11] = [
        ("auth.pin", String::new()),
        ("meta.tmdb_key", String::new()),
        ("meta.proxy", String::new()),
        ("notify.thresholds", "[14,7,3,1,0]".into()),
        ("notify.digest_time", "09:00".into()),
        ("notify.window_days", "14".into()),
        (
            "notify.telegram",
            r#"{"enabled":false,"bot_token":"","chat_id":"","proxy":""}"#.into(),
        ),
        (
            "notify.email",
            r#"{"enabled":false,"host":"","port":465,"starttls":false,"username":"","password":"","from":"","to":""}"#.into(),
        ),
        ("ics.token", ics_token),
        // 折算显示：空＝不折算，各币种分开呈现（原币入账那条永远不变）
        ("fx.display", String::new()),
        // 实时汇率默认关着：这一格为空就一直用 fx.rs 里的内置平均汇率
        ("fx.rates", String::new()),
    ];
    for (k, v) in &defaults {
        conn.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES(?1,?2)",
            rusqlite::params![k, v],
        )?;
    }
    Ok(())
}

/// 每个迁移单独一个事务：搬数据的迁移半途失败时要么整个生效、要么原样退回，
/// user_version 也跟着一起提交，不会出现"表建了但版本没推进"的中间态。
fn migrate(conn: &Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // 版本比这个二进制认识的还高＝这份数据是更新的 Kalends 写的（多半是回滚了部署）。
    // 照常启动的话旧代码会按旧结构读写新结构的库：列没了当成空、新列一律写不进去，
    // 而界面上一切正常。宁可起不来也别让它静默写坏账本。
    let known = MIGRATIONS.len() as i64;
    if current > known {
        return Err(anyhow::anyhow!(
            "数据库版本 {current} 高于本二进制支持的 {known}：这份数据是更新版本的 Kalends 写的，\
             换回那个版本启动，或从 backups/ 里的快照恢复"
        ));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if current >= target {
            continue;
        }
        conn.execute_batch("BEGIN")?;
        let done = conn
            .execute_batch(sql)
            .and_then(|_| conn.pragma_update(None, "user_version", target));
        match done {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(e) => {
                conn.execute_batch("ROLLBACK")?;
                return Err(anyhow::anyhow!("迁移 {target:04} 失败：{e}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回滚部署（新版本跑过一次、又换回旧二进制）时必须起不来：旧代码按旧结构读写一个
    /// 新结构的库，界面上看不出任何异常，等发现时已经写坏了。
    #[test]
    fn a_database_from_a_newer_build_refuses_to_start() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64 + 1)
            .unwrap();
        let err = migrate(&conn).unwrap_err().to_string();
        assert!(err.contains("高于本二进制支持的"), "{err}");
        // 版本正好等于已知迁移数＝跑满了的正常库，不能误伤
        conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64)
            .unwrap();
        assert!(migrate(&conn).is_ok());
    }
}
