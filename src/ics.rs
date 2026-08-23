use chrono::Utc;
use serde_json::Value;

fn esc(s: &str) -> String {
    // \r 先归一成 \n：接口写进来的文本可能带 \r\n，孤立的 CR 会把内容行掰成两行
    s.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

/// RFC 5545 的行折叠：一行最多 75 字节，续行以一个空格起头。
/// 按字节折，但不能切开一个 UTF-8 字符——中文名字二十几个字就越线了。
fn fold(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + line.len() / 64);
    let mut used = 0;
    for c in line.chars() {
        let n = c.len_utf8();
        if used + n > 75 {
            out.push_str("\r\n ");
            used = 1; // 续行的前导空格自己占一个字节
        }
        out.push(c);
        used += n;
    }
    out
}

fn put(out: &mut String, s: &str) {
    out.push_str(&fold(s));
    out.push_str("\r\n");
}

/// 把合并到期时间线渲染成 ICS 日历（每项一个全天事件，前一天日历级提醒）。
pub fn calendar(items: &[Value]) -> String {
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    let mut out = String::new();
    for l in [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Kalends//ZH",
        "CALSCALE:GREGORIAN",
        "X-WR-CALNAME:Kalends 续费",
    ] {
        put(&mut out, l);
    }
    for it in items {
        let kind = it["kind"].as_str().unwrap_or("item");
        let id = it["id"].as_i64().unwrap_or(0);
        let due = it["due"].as_str().unwrap_or("");
        let date = due.replace('-', "");
        let name = it["name"].as_str().unwrap_or("");
        // 到期动作说法由库给（SIM 是"保号"），不再按类型特判
        let verb = it["verb"].as_str().unwrap_or("续费");
        let summary = format!("{verb}：{name}");
        let mut desc = String::new();
        if let (Some(p), Some(c)) = (it["price"].as_f64(), it["currency"].as_str()) {
            desc.push_str(&format!("{c} {p:.2}"));
        }
        if let Some(a) = it["action"].as_str() {
            if !a.is_empty() {
                if !desc.is_empty() {
                    desc.push('\n');
                }
                desc.push_str(a);
            }
        }
        put(&mut out, "BEGIN:VEVENT");
        // UID 是事件的持久身份（RFC 5545），不掺到期日：掺了的话每次续费都是"新事件"，
        // 下载后导入的日历会攒出一堆重复
        put(&mut out, &format!("UID:kalends-{kind}-{id}"));
        put(&mut out, &format!("DTSTAMP:{stamp}"));
        put(&mut out, &format!("DTSTART;VALUE=DATE:{date}"));
        put(&mut out, &format!("SUMMARY:{}", esc(&summary)));
        put(&mut out, &format!("DESCRIPTION:{}", esc(&desc)));
        put(&mut out, "BEGIN:VALARM");
        put(&mut out, "ACTION:DISPLAY");
        put(&mut out, &format!("DESCRIPTION:{}", esc(&summary)));
        put(&mut out, "TRIGGER:-P1D");
        put(&mut out, "END:VALARM");
        put(&mut out, "END:VEVENT");
    }
    put(&mut out, "END:VCALENDAR");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn escapes_the_characters_that_would_break_a_line() {
        // 逗号与分号在 ICS 里是字段分隔符，名字里带它们不转义会把事件切断
        assert_eq!(esc("A, B; C"), "A\\, B\\; C");
        assert_eq!(esc("第一行\n第二行"), "第一行\\n第二行");
        assert_eq!(esc(r"C:\path"), r"C:\\path");
        // \r 也不能漏：孤立的 CR 会把内容行掰成两行，解析器眼里就是坏文件
        assert_eq!(esc("a\r\nb"), "a\\nb");
        assert_eq!(esc("a\rb"), "a\\nb");
    }

    /// UID 是事件的持久身份：跟着到期日走的话，每次续费在导入方眼里都是新事件，
    /// 日历里攒出一堆重复。
    #[test]
    fn the_uid_survives_a_renewal() {
        let event = |due: &str| {
            calendar(&[json!({ "kind": "subs", "id": 7, "due": due, "name": "x" })])
        };
        assert!(event("2026-08-01").contains("UID:kalends-subs-7\r\n"));
        assert!(event("2026-09-01").contains("UID:kalends-subs-7\r\n"));
    }

    #[test]
    fn renders_one_event_per_item_with_a_day_ahead_alarm() {
        let ics = calendar(&[json!({
            "kind": "subs", "id": 7, "due": "2026-08-01",
            "name": "Netflix, 家庭版", "verb": "续费",
            "price": 15.5, "currency": "USD",
        })]);
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\n") && ics.ends_with("END:VCALENDAR\r\n"));
        assert_eq!(ics.matches("BEGIN:VEVENT").count(), 1);
        assert!(ics.contains("UID:kalends-subs-7\r\n"));
        assert!(ics.contains("DTSTART;VALUE=DATE:20260801"));
        assert!(ics.contains("SUMMARY:续费：Netflix\\, 家庭版"));
        assert!(ics.contains("DESCRIPTION:USD 15.50"));
        assert!(ics.contains("TRIGGER:-P1D"));
    }

    #[test]
    fn folds_long_lines_without_splitting_a_character() {
        // 60 个汉字 = 180 字节，SUMMARY 行必然要折；折点不能落在字符中间
        let long = "朔".repeat(60);
        let ics = calendar(&[json!({
            "kind": "subs", "id": 1, "due": "2026-08-01", "name": long, "verb": "续费",
        })]);
        for l in ics.split("\r\n") {
            assert!(l.len() <= 75, "{} 字节的行没折：{l}", l.len());
        }
        assert!(ics.contains("\r\n "), "根本没有折行");
        // 把续行接回去应当还原成原样（RFC 5545 的解析方式）
        let unfolded = ics.replace("\r\n ", "");
        assert!(unfolded.contains(&format!("SUMMARY:续费：{long}")), "折回去对不上原文");
    }

    #[test]
    fn empty_timeline_still_produces_a_valid_calendar() {
        let ics = calendar(&[]);
        assert!(ics.contains("BEGIN:VCALENDAR") && ics.contains("END:VCALENDAR"));
        assert!(!ics.contains("BEGIN:VEVENT"));
    }
}
