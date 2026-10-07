//! 「今天」按 `TZ` 算、不按 UTC：同一份数据在恰差 24 小时的两个时区里，`today` 与同一条目的
//! 剩余天数恒差一天。容器默认 UTC，差几个小时就是「今天」错位、09:00 的摘要在别的钟点发出。

mod common;

use chrono::{NaiveDate, Utc};
use serde_json::Value;

use common::{http, start};

#[test]
fn today_and_days_left_follow_tz_not_utc() {
    // POSIX 的 Etc 区号符号是反的：GMT-14 是 UTC+14，GMT+10 是 UTC−10，两地恒差 24 小时
    let (de, dw) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (east, west) = (start(de.path(), &[("TZ", "Etc/GMT-14")]), start(dw.path(), &[("TZ", "Etc/GMT+10")]));
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
