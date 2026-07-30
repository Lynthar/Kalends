use chrono::Utc;
use serde_json::Value;

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

/// 把合并到期时间线渲染成 ICS 日历（每项一个全天事件，前一天日历级提醒）。
pub fn calendar(items: &[Value]) -> String {
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    let mut out = String::from(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kalends//ZH\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Kalends 续费\r\n",
    );
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
        out.push_str(&format!(
            "BEGIN:VEVENT\r\nUID:kalends-{kind}-{id}-{date}\r\nDTSTAMP:{stamp}\r\nDTSTART;VALUE=DATE:{date}\r\nSUMMARY:{}\r\nDESCRIPTION:{}\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:{}\r\nTRIGGER:-P1D\r\nEND:VALARM\r\nEND:VEVENT\r\n",
            esc(&summary),
            esc(&desc),
            esc(&summary),
        ));
    }
    out.push_str("END:VCALENDAR\r\n");
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
        assert!(ics.contains("UID:kalends-subs-7-20260801"));
        assert!(ics.contains("DTSTART;VALUE=DATE:20260801"));
        assert!(ics.contains("SUMMARY:续费：Netflix\\, 家庭版"));
        assert!(ics.contains("DESCRIPTION:USD 15.50"));
        assert!(ics.contains("TRIGGER:-P1D"));
    }

    #[test]
    fn empty_timeline_still_produces_a_valid_calendar() {
        let ics = calendar(&[]);
        assert!(ics.contains("BEGIN:VCALENDAR") && ics.contains("END:VCALENDAR"));
        assert!(!ics.contains("BEGIN:VEVENT"));
    }
}
