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
        let summary = if kind == "sim" {
            format!("保号：{name}")
        } else {
            format!("续费：{name}")
        };
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
