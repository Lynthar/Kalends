//! 容器探针 `kalends --health` 设了 PIN 也要看得见库：探针不带凭据，健康检查若在 PIN 门后面，
//! 它只拿得到 401，表坏了容器照样 healthy。

mod common;

use std::process::{Command, Stdio};

use common::{http, start, Server};

fn probe(s: &Server) -> Option<i32> {
    Command::new(env!("CARGO_BIN_EXE_kalends"))
        .arg("--health")
        .env("KALENDS_ADDR", format!("127.0.0.1:{}", s.port))
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .code()
}

#[test]
fn the_probe_sees_a_broken_table_behind_a_pin() {
    let data = tempfile::tempdir().unwrap();
    let s = start(data.path(), &[]);
    http(&s, "PUT", "/api/settings", r#"{"auth.pin":"1234"}"#).unwrap();
    assert_eq!(probe(&s), Some(0), "设了 PIN、库完好");

    let conn = rusqlite::Connection::open(data.path().join("kalends.db")).unwrap();
    conn.execute_batch("DROP TABLE notification_log").unwrap();
    drop(conn);
    assert_eq!(probe(&s), Some(1), "提醒要读的表没了，探针必须报不健康");
}
