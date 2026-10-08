//! 命令行分派：只有不带参数才起服。起服第一步是迁移数据库，认不得的参数若也起服，
//! 在部署目录里敲一句 `--version` 就会把在用的库迁到新版本。

mod common;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// 在一次性数据目录上跑二进制；起了服就不会自己退出，所以限时等，超时杀掉并判失败。
fn run(args: &[&str], data: &Path) -> ExitStatus {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kalends"))
        .args(args)
        .env("KALENDS_DATA", data)
        .env("KALENDS_ADDR", "127.0.0.1:0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("`kalends {}` 没有退出：它起服了", args.join(" "));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn arguments_it_does_not_know_exit_2_without_touching_the_data_directory() {
    let tmp = tempfile::tempdir().unwrap();
    for args in [&["--versoin"][..], &["-x"], &["serve"], &["--health", "now"], &["restore-db"]] {
        let data = tmp.path().join("data");
        assert_eq!(run(args, &data).code(), Some(2), "{args:?}");
        assert!(!data.exists(), "{args:?} 碰了数据目录");
    }
}

#[test]
fn version_and_help_answer_and_exit_without_touching_the_data_directory() {
    let tmp = tempfile::tempdir().unwrap();
    for args in [["--version"], ["-V"], ["--help"], ["-h"]] {
        let data = tmp.path().join("data");
        assert_eq!(run(&args, &data).code(), Some(0), "{args:?}");
        assert!(!data.exists(), "{args:?} 碰了数据目录");
    }
    let out = Command::new(env!("CARGO_BIN_EXE_kalends")).arg("--version").output().unwrap();
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), format!("kalends {}", env!("CARGO_PKG_VERSION")));
}

/// `docker logs` 与重定向到文件时 stdout 不是终端：日志里不能带颜色转义序列。
#[test]
fn the_log_carries_no_colour_codes_when_stdout_is_not_a_terminal() {
    let tmp = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kalends"))
        .env("KALENDS_DATA", tmp.path().join("data"))
        .env("KALENDS_ADDR", "127.0.0.1:0")
        .env_remove("NO_COLOR")
        .env_remove("RUST_LOG")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let out = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = Vec::new();
    while !seen.iter().any(|l: &String| l.contains("local time")) {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) => seen.push(line),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(seen.iter().any(|l| l.contains("local time")), "没等到启动日志：{seen:?}");
    assert!(!seen.iter().any(|l| l.contains('\x1b')), "日志带了转义序列：{seen:?}");
}

/// `--from backups/x.db` 在数据目录里敲：推出来的原数据目录是空路径，要报成当前目录而不是空白。
#[test]
fn restore_from_a_relative_snapshot_names_the_current_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let snapshot = {
        let server = common::start(&data, &[]);
        let r = common::http(&server, "POST", "/api/backup", "").expect("备份没成");
        Path::new(r["snapshot"].as_str().unwrap()).file_name().unwrap().to_string_lossy().into_owned()
    };
    let to = tmp.path().join("restored");
    let out = Command::new(env!("CARGO_BIN_EXE_kalends"))
        .current_dir(&data)
        .args(["restore", "--from", &format!("backups/{snapshot}"), "--to"])
        .arg(&to)
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(out.status.code(), Some(0), "{stdout}");
    assert!(stdout.contains("已从 . 复制 logos/"), "{stdout}");
}
