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
];

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
    let defaults: [(&str, String); 9] = [
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
    ];
    for (k, v) in &defaults {
        conn.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES(?1,?2)",
            rusqlite::params![k, v],
        )?;
    }
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if current < target {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", target)?;
        }
    }
    Ok(())
}
