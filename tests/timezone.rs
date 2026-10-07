//! 「今天」按 `TZ` 算、不按 UTC：同一份数据在恰差 24 小时的两个时区里，`today` 与同一条目的
//! 剩余天数恒差一天。容器默认 UTC，差几个小时就是「今天」错位、09:00 的摘要在别的钟点发出。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use chrono::{NaiveDate, Utc};
use serde_json::Value;

/// 一次性实例：自己的数据目录、自己的端口，测试结束（含 panic）时杀掉。
struct Server {
    child: Child,
    port: u16,
    _data: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start(tz: &str) -> Server {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let data = tempfile::tempdir().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_kalends"))
        .env("KALENDS_DATA", data.path())
        .env("KALENDS_ADDR", format!("127.0.0.1:{port}"))
        .env("TZ", tz)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let server = Server { child, port, _data: data };
    let deadline = Instant::now() + Duration::from_secs(10);
    while http(&server, "GET", "/api/health", "").is_none() {
        assert!(Instant::now() < deadline, "TZ={tz} 的实例没起来");
        std::thread::sleep(Duration::from_millis(50));
    }
    server
}

/// 一问一答的 HTTP/1.1；不是 2xx、连不上或体不是 JSON 都给 None。
fn http(s: &Server, method: &str, path: &str, body: &str) -> Option<Value> {
    let mut conn = TcpStream::connect(("127.0.0.1", s.port)).ok()?;
    write!(
        conn,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .ok()?;
    let mut out = String::new();
    conn.read_to_string(&mut out).ok()?;
    let (head, rest) = out.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 2").then_some(())?;
    serde_json::from_str(rest).ok()
}

#[test]
fn today_and_days_left_follow_tz_not_utc() {
    // POSIX 的 Etc 区号符号是反的：GMT-14 是 UTC+14，GMT+10 是 UTC−10，两地恒差 24 小时
    let (east, west) = (start("Etc/GMT-14"), start("Etc/GMT+10"));
    let item = r#"{"name":"t","status":"Active","cycle":"monthly","next_renewal":"2030-01-15"}"#;
    for s in [&east, &west] {
        http(s, "POST", "/api/collections/subs/items", item).unwrap();
    }
    let local = |hours: i64| (Utc::now() + chrono::Duration::hours(hours)).date_naive();
    let before = (local(14), local(-10));
    let (oe, ow) = (http(&east, "GET", "/api/overview", "").unwrap(), http(&west, "GET", "/api/overview", "").unwrap());
    let after = (local(14), local(-10));

    let today = |o: &Value| NaiveDate::parse_from_str(o["today"].as_str().unwrap(), "%Y-%m-%d").unwrap();
    let left = |o: &Value| o["upcoming"][0]["days_left"].as_i64().unwrap();
    let due = NaiveDate::from_ymd_opt(2030, 1, 15).unwrap();
    let (te, tw) = (today(&oe), today(&ow));
    assert!(te == before.0 || te == after.0, "UTC+14 的 today={te}，按时钟应是 {} 或 {}", before.0, after.0);
    assert!(tw == before.1 || tw == after.1, "UTC−10 的 today={tw}，按时钟应是 {} 或 {}", before.1, after.1);
    assert_eq!(left(&oe), (due - te).num_days());
    assert_eq!(left(&ow), (due - tw).num_days());
    // 两地在同一刻（UTC 10:00）跨日；两次请求之间恰好跨过去时差值不定，只在没跨时比
    if before == after {
        assert_eq!((te - tw).num_days(), 1);
        assert_eq!(left(&ow) - left(&oe), 1);
    }
}
