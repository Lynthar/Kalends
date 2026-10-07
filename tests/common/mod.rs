//! 集成测试共用：起一次性实例、对它发一问一答的 HTTP。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

/// 一次性实例：自己的端口，测试结束（含 panic）时杀掉。数据目录归调用方，要比实例活得长。
pub struct Server {
    child: Child,
    pub port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 在 `data` 上起服并等到 `/api/health` 答话；`env` 叠加在数据目录与端口之上。
pub fn start(data: &Path, env: &[(&str, &str)]) -> Server {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let child = Command::new(env!("CARGO_BIN_EXE_kalends"))
        .env("KALENDS_DATA", data)
        .env("KALENDS_ADDR", format!("127.0.0.1:{port}"))
        .envs(env.iter().copied())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let server = Server { child, port };
    let deadline = Instant::now() + Duration::from_secs(10);
    while http(&server, "GET", "/api/health", "").is_none() {
        assert!(Instant::now() < deadline, "{env:?} 的实例没起来");
        std::thread::sleep(Duration::from_millis(50));
    }
    server
}

/// 一问一答的 HTTP/1.1；不是 2xx、连不上或体不是 JSON 都给 None。
pub fn http(s: &Server, method: &str, path: &str, body: &str) -> Option<Value> {
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
