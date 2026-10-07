//! 命令行分派：只有不带参数才起服。起服第一步是迁移数据库，认不得的参数若也起服，
//! 在部署目录里敲一句 `--version` 就会把在用的库迁到新版本。

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
