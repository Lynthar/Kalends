//! 容器探针 `kalends --health` 设了 PIN 也要看得见库：探针不带凭据，健康检查若在 PIN 门后面，
//! 它只拿得到 401，表坏了容器照样 healthy。

mod common;

use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::{http, start, Server};

fn probe(s: &Server) -> Option<i32> {
    probe_at(s.port, &[])
}

/// 跑一次探针；10 s 还不退就杀掉并给 None（探针自己挂住正是要测的缺陷之一）。
fn probe_at(port: u16, env: &[(&str, &str)]) -> Option<i32> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kalends"))
        .arg("--health")
        .env("KALENDS_ADDR", format!("127.0.0.1:{port}"))
        .env_remove("NO_PROXY")
        .env_remove("no_proxy")
        .envs(env.iter().copied())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(st) = child.try_wait().unwrap() {
            return st.code();
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
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

/// 探针连的是本机：进程环境里的代理变量（容器里常带着）不能把它绕到代理那儿去；
/// 对端接了连接却不应答时，它要赶在容器 HEALTHCHECK 的 5 s 之前自己报错退出。
#[test]
fn the_probe_goes_direct_and_gives_up_on_a_silent_peer() {
    let data = tempfile::tempdir().unwrap();
    let s = start(data.path(), &[]);
    let dead = "http://127.0.0.1:9";
    let proxied = [("HTTP_PROXY", dead), ("http_proxy", dead), ("ALL_PROXY", dead), ("all_proxy", dead)];
    assert_eq!(probe_at(s.port, &proxied), Some(0), "环境里的代理不该挡住探针连本机");

    let silent = TcpListener::bind("127.0.0.1:0").unwrap();
    let started = Instant::now();
    assert_eq!(probe_at(silent.local_addr().unwrap().port(), &[]), Some(1));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}
