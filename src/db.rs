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
    pre_migration_snapshot(&conn, data_dir)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 本二进制认识的最高数据库版本（恢复命令校验快照用同一把尺）。
pub fn known_version() -> i64 {
    MIGRATIONS.len() as i64
}

/// 升级启动（版本介于 1 与目标之间）先落一份迁移前快照到 backups/，失败就拒绝启动：
/// 写不进快照的盘多半也跑不完迁移，宁可停在还有整份备份的这一步。
fn pre_migration_snapshot(conn: &Connection, data_dir: &Path) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // 全新安装不用备、版本过高交给 migrate() 报它那条更明白的错
    if current == 0 || current >= MIGRATIONS.len() as i64 {
        return Ok(());
    }
    let backups = data_dir.join("backups");
    std::fs::create_dir_all(&backups)?;
    let snap = backups.join(format!("pre-migration-v{current}.db"));
    let tmp = snap.with_extension("db.tmp");
    // 同名残留是上次失败重试的陈货：VACUUM INTO 不覆盖既有文件，先清掉；
    // 正式名等 tmp 写完才动，任何一步失败都不赔上一份已有的好快照
    let _ = std::fs::remove_file(&tmp);
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])?;
    let _ = std::fs::remove_file(&snap);
    std::fs::rename(&tmp, &snap)?;
    tracing::info!("pre-migration snapshot: {}", snap.display());
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .ok()
}

/// 与 `get_setting` 的区别是**区分「没这个键」与「读不出来」**。认证边界（PIN 门）必须用
/// 它：把数据库故障当成"没设 PIN"，门就在最不该开的时候敞开了。
pub fn get_setting_checked(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .optional()
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
             换回那个版本启动，或用 kalends restore 从 backups/ 里的快照恢复"
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

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// 停在历史版本 N 的库：按仓库里真实的迁移文件建 schema，再灌入该时代的 fixture 数据。
    fn db_at(version: usize, fixture: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in &MIGRATIONS[..version] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", version as i64).unwrap();
        conn.execute_batch(fixture).unwrap();
        conn
    }

    fn assert_healthy(conn: &Connection) {
        assert_eq!(one::<String>(conn, "PRAGMA integrity_check"), "ok");
        let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
        assert!(stmt.query([]).unwrap().next().unwrap().is_none());
    }

    /// 从 v4（库泛化之前的最后形态）一路迁到当前：0006 状态翻译、0007 搬运与重指、
    /// 0010/0011 删旧表、0012 NOCASE 回填、0013–0019 各钉一处逐值对拍。
    #[test]
    fn a_v4_era_database_upgrades_to_current_with_every_value_accounted_for() {
        let conn = db_at(4, include_str!("../tests/fixtures/uv04-data.sql"));
        migrate(&conn).unwrap();
        assert_healthy(&conn);
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), known_version());

        // 0010/0011：旧表连数据一起退场，0007 的映射表也不残留
        for t in ["subscriptions", "sim_cards", "vps_instances", "price_history", "_migr_map"] {
            let n: i64 = one(&conn, &format!("SELECT count(*) FROM sqlite_master WHERE name='{t}'"));
            assert_eq!(n, 0, "{t} 应当已删除");
        }
        // 0006：中文状态词逐个翻译（订阅本就是英文）
        for (name, status) in [
            ("🇬🇧 ExampleTel", "Active"),
            ("AnyTel", "Unused"),
            ("OldTel", "Ended"),
            ("ExampleHost", "Ending"),
            ("NodeCo", "Planned"),
        ] {
            let got: String = one(&conn, &format!("SELECT status FROM items WHERE name='{name}'"));
            assert_eq!(got, status, "{name}");
        }
        // 0007：父子档位按显式映射重指（老 id 10/20/30 不连续，吃 rowid 的巧会在这里翻车）
        let parent: i64 = one(&conn, "SELECT parent_id FROM items WHERE name='Pro tier'");
        assert_eq!(parent, one::<i64>(&conn, "SELECT id FROM items WHERE name='Beta Cloud'"));
        // 0007：域字段进 extra；json_patch 把 NULL 键整个丢掉、坏 JSON 从 {} 起步
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.category') FROM items WHERE name='Beta Cloud'"), "CloudSvc");
        assert_eq!(one::<Option<String>>(&conn, "SELECT json_extract(extra,'$.payment_method') FROM items WHERE name='Beta Cloud'"), None);
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.payment_method') FROM items WHERE name='Pro tier'"), "Visa");
        assert_eq!(one::<Option<String>>(&conn, "SELECT json_extract(extra,'$.c1') FROM items WHERE name='Pro tier'"), None);
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.c1') FROM items WHERE name='alpha Host'"), "自定义值");
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.category') FROM items WHERE name='alpha Host'"), "DevTools");
        // SIM：保号天数并入通用周期模型（0 天不算有周期）；forms 是数组，坏 JSON 的整键消失
        assert_eq!(one::<String>(&conn, "SELECT cycle FROM items WHERE name='🇬🇧 ExampleTel'"), "days");
        assert_eq!(one::<i64>(&conn, "SELECT json_array_length(extra,'$.forms') FROM items WHERE name='🇬🇧 ExampleTel'"), 2);
        assert_eq!(one::<Option<String>>(&conn, "SELECT cycle FROM items WHERE name='OldTel'"), None);
        assert_eq!(one::<Option<String>>(&conn, "SELECT json_extract(extra,'$.forms') FROM items WHERE name='OldTel'"), None);
        // VPS：商家为名、规格进 extra 且数值保持数值；全空行的 extra 恰是 {}
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.product') FROM items WHERE name='ExampleHost'"), "VPS-Basic");
        assert_eq!(one::<i64>(&conn, "SELECT json_extract(extra,'$.ipv6') FROM items WHERE name='ExampleHost'"), 1);
        assert_eq!(one::<String>(&conn, "SELECT extra FROM items WHERE name='NodeCo'"), "{}");
        // 0007：台账与通知日志重指到新 id；悬空行原样不动（迁移不发明映射）
        let pro: i64 = one(&conn, "SELECT id FROM items WHERE name='Pro tier'");
        assert_eq!(one::<i64>(&conn, "SELECT item_id FROM renewal_ledger WHERE kind='subs'"), pro);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM renewal_ledger WHERE kind='sim' AND item_id=999"), 1);
        assert_eq!(one::<i64>(&conn, "SELECT item_id FROM notification_log WHERE kind='subs'"), pro);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM notification_log WHERE kind='subscription' AND item_id=999"), 1);
        // 0018：活着的行回填真名；悬空行 kind 还是旧词，连库名都填不上
        assert_eq!(one::<String>(&conn, "SELECT item_name FROM renewal_ledger WHERE kind='subs'"), "Pro tier");
        assert_eq!(one::<String>(&conn, "SELECT coll_name FROM renewal_ledger WHERE kind='subs'"), "订阅");
        assert_eq!(one::<String>(&conn, "SELECT item_name FROM renewal_ledger WHERE kind='sims'"), "🇬🇧 ExampleTel");
        assert_eq!(one::<Option<String>>(&conn, "SELECT item_name FROM renewal_ledger WHERE kind='sim'"), None);
        assert_eq!(one::<Option<String>>(&conn, "SELECT coll_name FROM renewal_ledger WHERE kind='sim'"), None);
        // 0012：库内 pos 按 NOCASE 名序回填（'alpha' 排在 'Beta' 前，正是与 BINARY 的分界）；
        // 媒体按标记日期倒序、没标记的沉底
        let order = |sql: &str| -> Vec<String> {
            let mut stmt = conn.prepare(sql).unwrap();
            let v: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
            v
        };
        assert_eq!(
            order("SELECT name FROM items WHERE collection_id=(SELECT id FROM collections WHERE key='subs') ORDER BY pos"),
            ["alpha Host", "Beta Cloud", "Pro tier"]
        );
        assert_eq!(
            order("SELECT title FROM media_items ORDER BY pos"),
            ["Example Show C", "Example Film A", "Example Film D", "Example Game B"]
        );
        // 0008：自定义列 src='extra'；状态词表播上语义标记
        assert_eq!(one::<String>(&conn, "SELECT src FROM fields WHERE tbl='subs' AND key='c1'"), "extra");
        assert_eq!(one::<i64>(&conn, "SELECT json_array_length(options) FROM fields WHERE tbl='subs' AND key='status'"), 6);
        assert_eq!(one::<i64>(&conn, "SELECT json_extract(options,'$[0].spend') FROM fields WHERE tbl='subs' AND key='status'"), 1);
        // 0013：currency 不再是注册列；0014：域字段收归 builtin=0，通用字段仍是 1
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM fields WHERE key='currency'"), 0);
        assert_eq!(one::<i64>(&conn, "SELECT builtin FROM fields WHERE tbl='subs' AND key='category'"), 0);
        assert_eq!(one::<i64>(&conn, "SELECT builtin FROM fields WHERE tbl='subs' AND key='name'"), 1);
        // 0015/0016：号码成了电话字段；规格模板换成带端口流量的播种版
        assert_eq!(one::<String>(&conn, "SELECT ftype FROM fields WHERE tbl='sims' AND key='phone_number'"), "tel");
        assert!(one::<String>(&conn, "SELECT json_extract(config,'$.tpl') FROM fields WHERE tbl='vps' AND key='spec'").contains("Gbps"));
        // 0017：due_anchor 与 renew_from 拆成正交两轴后各归各位
        assert_eq!(one::<String>(&conn, "SELECT renew_from FROM collections WHERE key='subs'"), "schedule");
        assert_eq!(one::<String>(&conn, "SELECT renew_from FROM collections WHERE key='sims'"), "today");
        assert_eq!(one::<String>(&conn, "SELECT renew_from FROM collections WHERE key='vps'"), "schedule");
        // 0019：五星制等比换到十分制，0 分摘成未评分
        assert_eq!(one::<i64>(&conn, "SELECT rating FROM media_items WHERE title='Example Film A'"), 8);
        assert_eq!(one::<i64>(&conn, "SELECT rating FROM media_items WHERE title='Example Film D'"), 10);
        assert_eq!(one::<Option<i64>>(&conn, "SELECT rating FROM media_items WHERE title='Example Game B'"), None);
        assert_eq!(one::<Option<i64>>(&conn, "SELECT rating FROM media_items WHERE title='Example Show C'"), None);
    }

    /// 从 v14（新架构时代）迁到当前：自定义库/自定义列/extra 原样存续，
    /// 0016「用户改过就不动」的防线、0017 的默认值落点、0018 的近似回填各钉一处。
    #[test]
    fn a_v14_era_database_with_custom_shapes_upgrades_intact() {
        let conn = db_at(14, include_str!("../tests/fixtures/uv14-data.sql"));
        migrate(&conn).unwrap();
        assert_healthy(&conn);
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), known_version());

        // 用户的东西一个不少：自定义库、自定义列的词表、extra 逐键
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.c1') FROM items WHERE name='Example Plus'"), "月付");
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.payment_method') FROM items WHERE name='Example Plus'"), "PayPal");
        assert_eq!(one::<String>(&conn, "SELECT options FROM fields WHERE tbl='subs' AND key='c1'"), r#"["月付","年付"]"#);
        // 0016 的防线：用户自定义过的规格模板一个字都不动
        assert_eq!(one::<String>(&conn, "SELECT json_extract(config,'$.tpl') FROM fields WHERE tbl='vps' AND key='spec'"), "{cores}C/{ram_gb}G");
        // 0015：只翻类型，行数据原样
        assert_eq!(one::<String>(&conn, "SELECT ftype FROM fields WHERE tbl='sims' AND key='phone_number'"), "tel");
        assert_eq!(one::<String>(&conn, "SELECT json_extract(extra,'$.phone_number') FROM items WHERE name='ExampleTel'"), "+44 7700 900456");
        // 0017：last 锚点回置 today、vps 独留 schedule、next 锚点（含自定义库）吃默认 schedule
        assert_eq!(one::<String>(&conn, "SELECT renew_from FROM collections WHERE key='subs'"), "schedule");
        assert_eq!(one::<String>(&conn, "SELECT renew_from FROM collections WHERE key='sims'"), "today");
        assert_eq!(one::<String>(&conn, "SELECT renew_from FROM collections WHERE key='vps'"), "schedule");
        assert_eq!(one::<String>(&conn, "SELECT renew_from FROM collections WHERE key='books'"), "schedule");
        // 0018：条目在的回填真名；条目没了库还在——库名照填、条目名留空
        assert_eq!(one::<String>(&conn, "SELECT item_name FROM renewal_ledger WHERE kind='subs'"), "Example Plus");
        assert_eq!(one::<Option<String>>(&conn, "SELECT item_name FROM renewal_ledger WHERE kind='books'"), None);
        assert_eq!(one::<String>(&conn, "SELECT coll_name FROM renewal_ledger WHERE kind='books'"), "藏书");
        // 0019
        assert_eq!(one::<i64>(&conn, "SELECT rating FROM media_items WHERE title='Example Film E'"), 6);
        assert_eq!(one::<Option<i64>>(&conn, "SELECT rating FROM media_items WHERE title='Example Game F'"), None);
    }

    /// 升级启动必须先落迁移前快照（停在旧版本的整份库）；全新安装不落；落不下去就不启动。
    #[test]
    fn an_upgrade_start_snapshots_the_database_before_migrating() {
        fn stage_v4(dir: &Path) {
            let conn = Connection::open(dir.join("kalends.db")).unwrap();
            for sql in &MIGRATIONS[..4] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 4).unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        stage_v4(dir.path());
        let conn = open(dir.path()).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), known_version());
        let frozen = Connection::open_with_flags(
            dir.path().join("backups").join("pre-migration-v4.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(one::<i64>(&frozen, "PRAGMA user_version"), 4);

        // 全新安装没有可备的东西，不该留下 backups/
        let fresh = tempfile::tempdir().unwrap();
        open(fresh.path()).unwrap();
        assert!(!fresh.path().join("backups").exists());

        // 负向对照：backups 被文件占位（快照写不进去）时必须拒绝启动
        let blocked = tempfile::tempdir().unwrap();
        stage_v4(blocked.path());
        std::fs::write(blocked.path().join("backups"), b"x").unwrap();
        assert!(open(blocked.path()).is_err());
    }

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

    /// 「没这个键」与「读不出来」必须分开：`get_setting` 把两者都折成 None，
    /// PIN 门拿 None 当"没设 PIN"——settings 表一坏，门就开了。
    #[test]
    fn a_broken_settings_table_reads_as_an_error_not_as_no_pin() {
        let conn = fresh_in_memory().unwrap();
        assert_eq!(get_setting_checked(&conn, "auth.pin").unwrap(), None);
        conn.execute(
            "INSERT INTO settings(key,value) VALUES('auth.pin','1234')",
            [],
        )
        .unwrap();
        assert_eq!(
            get_setting_checked(&conn, "auth.pin").unwrap(),
            Some("1234".into())
        );
        conn.execute_batch("DROP TABLE settings").unwrap();
        assert!(get_setting_checked(&conn, "auth.pin").is_err());
        // 旧函数在同一故障下给的是 None——这正是 fail-open 的样子，别再有人把门改回去
        assert_eq!(get_setting(&conn, "auth.pin"), None);
    }
}
