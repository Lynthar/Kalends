//! 设置项的声明表。播种、写入口校验、密钥遮蔽与 `GET /api/settings/defaults` 都从
//! `SPECS` 派生，读侧回落也从这里解析——默认值只许写在这一处。

use serde_json::Value;

use crate::api::bad;

#[derive(Clone, Copy)]
pub enum Seed {
    Fixed(&'static str),
    RandomHex16,
    /// 只由代码写入（汇率拉取的时间戳），首启不播。
    Never,
}

pub struct Spec {
    pub key: &'static str,
    pub seed: Seed,
    /// 写入口校验：只拦一眼可辨的垃圾，读侧仍保留宽容回落。
    pub check: fn(&str) -> anyhow::Result<()>,
    /// 值是 JSON 对象时不回读明文的那个字段。
    pub secret: Option<&'static str>,
}

pub const SPECS: &[Spec] = &[
    Spec { key: "auth.pin", seed: Seed::Fixed(""), check: pin, secret: None },
    Spec { key: "meta.proxy", seed: Seed::Fixed(""), check: proxy, secret: None },
    Spec { key: "notify.thresholds", seed: Seed::Fixed("[14,7,3,1,0]"), check: thresholds, secret: None },
    Spec { key: "notify.digest_time", seed: Seed::Fixed("09:00"), check: hhmm, secret: None },
    Spec { key: "notify.window_days", seed: Seed::Fixed("14"), check: window_days, secret: None },
    Spec { key: "ui.upcoming_days", seed: Seed::Fixed("30"), check: upcoming_days, secret: None },
    Spec {
        key: "notify.telegram",
        seed: Seed::Fixed(r#"{"enabled":false,"bot_token":"","chat_id":"","proxy":""}"#),
        check: channel,
        secret: Some("bot_token"),
    },
    Spec {
        key: "notify.email",
        seed: Seed::Fixed(r#"{"enabled":false,"host":"","port":465,"starttls":false,"username":"","password":"","from":"","to":""}"#),
        check: channel,
        secret: Some("password"),
    },
    Spec { key: "ics.token", seed: Seed::RandomHex16, check: token, secret: None },
    // 折算显示：空＝不折算，各币种分开呈现（原币入账那条永远不变）
    Spec { key: "fx.display", seed: Seed::Fixed(""), check: currency, secret: None },
    // 实时汇率默认关着：这一格为空就一直用 fx.rs 里的内置平均汇率
    Spec { key: "fx.rates", seed: Seed::Fixed(""), check: pass, secret: None },
    Spec { key: "fx.fetched_at", seed: Seed::Never, check: pass, secret: None },
];

pub fn spec(key: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.key == key)
}

/// 密钥不出库的占位串。输入框里就是一排点，前端不必知道这套机制存在。
pub const SECRET_MASK: &str = "••••••••";

pub fn secret_field(key: &str) -> Option<&'static str> {
    spec(key).and_then(|s| s.secret)
}

/// 设置接口回读的值：密钥字段换成占位串。带密钥的键存值解析不出时整串换掉——
/// 原样吐出就把密钥连同坏 JSON 一起交了出去。
pub fn masked(key: &str, stored: &str) -> String {
    let Some(field) = secret_field(key) else { return stored.into() };
    let Ok(mut v) = serde_json::from_str::<Value>(stored) else { return SECRET_MASK.into() };
    if v[field].as_str().is_some_and(|s| !s.is_empty()) {
        v[field] = Value::from(SECRET_MASK);
    }
    v.to_string()
}

/// JSONL 导出的值：在 `masked` 之外把代理地址里的口令也遮掉（裸值与 JSON 对象的字符串字段
/// 都算）。ICS 令牌与 PIN 与设置接口一致，不遮。
pub fn exported(key: &str, stored: &str) -> String {
    let out = masked(key, stored);
    let Ok(Value::Object(mut o)) = serde_json::from_str::<Value>(&out) else {
        return without_url_password(&out);
    };
    let mut changed = false;
    for v in o.values_mut() {
        if let Value::String(s) = v {
            let r = without_url_password(s);
            changed |= r != *s;
            *s = r;
        }
    }
    if changed { Value::Object(o).to_string() } else { out }
}

/// `socks5://user:pass@host` → `socks5://user:••••••••@host`；没有口令的原样返回。
fn without_url_password(s: &str) -> String {
    let Some(start) = s.find("://").map(|i| i + 3) else { return s.into() };
    let rest = &s[start..];
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let Some(at) = authority.rfind('@') else { return s.into() };
    match authority[..at].find(':') {
        Some(colon) if colon + 1 < at => {
            format!("{}{SECRET_MASK}{}", &s[..=start + colon], &s[start + at..])
        }
        _ => s.into(),
    }
}

/// 所有固定默认值，键即设置键（随机令牌与只由代码写的键不在其中）。
pub fn defaults_json() -> Value {
    SPECS
        .iter()
        .filter_map(|s| match s.seed {
            Seed::Fixed(d) => Some((s.key.to_string(), Value::from(d))),
            _ => None,
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

// 读侧回落用的默认值：存值解析不出时用它们。从声明解析而不是再写一遍；
// 解析不出是声明写坏了，单测钉着，不在运行时悄悄回落成别的数。
pub fn window_days_default() -> i64 {
    fixed("notify.window_days").parse().expect("notify.window_days declares an integer")
}

pub fn thresholds_default() -> Vec<i64> {
    serde_json::from_str(fixed("notify.thresholds")).expect("notify.thresholds declares an integer array")
}

pub fn digest_time_default() -> &'static str {
    fixed("notify.digest_time")
}

pub fn smtp_port_default() -> u16 {
    serde_json::from_str::<Value>(fixed("notify.email"))
        .ok()
        .and_then(|v| v["port"].as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .expect("notify.email declares a port")
}

fn fixed(key: &str) -> &'static str {
    match spec(key).map(|s| s.seed) {
        Some(Seed::Fixed(d)) => d,
        _ => panic!("{key} has no fixed default"),
    }
}

fn int_in(v: &str, lo: i64, hi: i64, what: &str) -> anyhow::Result<()> {
    v.trim()
        .parse::<i64>()
        .ok()
        .filter(|n| (lo..=hi).contains(n))
        .map(|_| ())
        .ok_or_else(|| bad(format!("{what}要是 {lo}–{hi} 的整数")))
}

fn pin(v: &str) -> anyhow::Result<()> {
    (v.is_empty() || (v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric())))
        .then_some(())
        .ok_or_else(|| bad("PIN 只收字母与数字（至多 64 位）；留空＝不设门"))
}

fn window_days(v: &str) -> anyhow::Result<()> {
    int_in(v, 1, 3650, "摘要窗口")
}

fn upcoming_days(v: &str) -> anyhow::Result<()> {
    if v == "all" {
        return Ok(()); // 到期栏下拉的「全部」档
    }
    int_in(v, 1, 3650, "到期窗口")
}

fn hhmm(v: &str) -> anyhow::Result<()> {
    (v.is_ascii()
        && v.len() == 5
        && v.as_bytes()[2] == b':'
        && v[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && v[3..].parse::<u8>().is_ok_and(|m| m < 60))
    .then_some(())
    .ok_or_else(|| bad("摘要时刻要是 HH:MM"))
}

fn thresholds(v: &str) -> anyhow::Result<()> {
    let arr: Vec<i64> =
        serde_json::from_str(v).map_err(|_| bad("提醒阈值要是整数数组（可以为空）"))?;
    (arr.len() <= 32 && arr.iter().all(|n| (0..=3650).contains(n)))
        .then_some(())
        .ok_or_else(|| bad("提醒阈值每项要在 0–3650 天"))
}

fn channel(v: &str) -> anyhow::Result<()> {
    let o: Value = serde_json::from_str(v).map_err(|_| bad("渠道配置要是 JSON 对象"))?;
    let o = o.as_object().ok_or_else(|| bad("渠道配置要是 JSON 对象"))?;
    for (fk, fv) in o {
        let ok = match fk.as_str() {
            "enabled" | "starttls" => fv.is_boolean(),
            "port" => fv.is_u64(),
            _ => fv.is_string(),
        };
        if !ok {
            return Err(bad(format!("渠道配置 {fk} 的类型不对")));
        }
    }
    // 端口在写入口就拦：环绕成没人配过的端口号之后，读侧只能悄悄回落默认
    if let Some(p) = o.get("port") {
        p.as_u64()
            .filter(|p| (1..=65535).contains(p))
            .ok_or_else(|| bad("SMTP 端口要在 1–65535"))?;
    }
    Ok(())
}

fn currency(v: &str) -> anyhow::Result<()> {
    let t = v.trim();
    (t.is_empty() || (t.len() == 3 && t.chars().all(|c| c.is_ascii_alphabetic())))
        .then_some(())
        .ok_or_else(|| bad("显示币种要是三位字母代码，留空＝不折算"))
}

fn token(v: &str) -> anyhow::Result<()> {
    (!v.is_empty()
        && v.len() <= 128
        && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then_some(())
    .ok_or_else(|| bad("ICS 令牌要是非空的 URL 安全字符串——空令牌等于把日历开给所有人"))
}

fn proxy(v: &str) -> anyhow::Result<()> {
    (v.is_empty() || v.contains("://"))
        .then_some(())
        .ok_or_else(|| bad("代理要是带协议的地址（如 socks5://…），留空＝直连"))
}

fn pass(_: &str) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// 默认值被自己的校验拒掉，是「合法值不在校验域内」那类病：
    /// 播种完第一次保存设置页就 400，而界面上看不出哪一项。
    #[test]
    fn every_fixed_default_passes_its_own_check() {
        for s in SPECS {
            if let Seed::Fixed(d) = s.seed {
                assert!((s.check)(d).is_ok(), "{}={d}", s.key);
            }
        }
    }

    /// 播种出来的键集就是声明里 `seed != Never` 的键集：表里加键忘播、
    /// 或播种绕开了表，都在这里红。随机令牌也得过自己的校验。
    #[test]
    fn seeded_keys_are_exactly_the_declared_ones() {
        let conn = crate::db::fresh_in_memory().unwrap();
        crate::db::seed_defaults(&conn).unwrap();
        let mut stmt = conn.prepare("SELECT key FROM settings").unwrap();
        let seeded: BTreeSet<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let declared: BTreeSet<String> = SPECS
            .iter()
            .filter(|s| !matches!(s.seed, Seed::Never))
            .map(|s| s.key.to_string())
            .collect();
        assert_eq!(seeded, declared);
        let tok = crate::db::get_setting(&conn, "ics.token").unwrap().unwrap();
        assert!(token(&tok).is_ok(), "{tok}");
        // 端点只下发固定默认值，且每个固定默认值都在
        let json = defaults_json();
        assert_eq!(json.as_object().unwrap().len(), SPECS.iter().filter(|s| matches!(s.seed, Seed::Fixed(_))).count());
        for s in SPECS {
            if let Seed::Fixed(d) = s.seed {
                assert_eq!(json[s.key], d, "{}", s.key);
            }
        }
    }

    /// 只遮口令一段：协议、用户名、主机端口留着，导出里还看得出连的是哪个代理。
    #[test]
    fn url_passwords_are_masked_and_nothing_else() {
        let m = SECRET_MASK;
        assert_eq!(without_url_password("socks5://u:p@10.0.0.5:1080"), format!("socks5://u:{m}@10.0.0.5:1080"));
        assert_eq!(without_url_password("http://u:p@a@h/x?y=@z"), format!("http://u:{m}@h/x?y=@z"));
        for same in ["", "socks5://10.0.0.5:1080", "http://u@h", "http://u:@h", "http://h/p:q@r", "not a url"] {
            assert_eq!(without_url_password(same), same);
        }
        assert_eq!(exported("meta.proxy", "http://u:p@h"), format!("http://u:{m}@h"));
        // 没东西可遮的 JSON 原样返回，不经重新序列化
        assert_eq!(exported("fx.rates", r#"{"USD": 7.10}"#), r#"{"USD": 7.10}"#);
    }

    /// 读侧回落值恒等声明里的播种值：设置页「清空＝回默认」显示的就是它们，两边不等就是
    /// 界面说一个数、调度器用另一个数。465 是 RFC 8314 的隐式 TLS 投递端口（声明里 starttls 关）。
    #[test]
    fn read_side_defaults_parse_out_of_the_declaration() {
        assert_eq!(window_days_default(), 14);
        assert_eq!(thresholds_default(), [14, 7, 3, 1, 0]);
        assert_eq!(digest_time_default(), "09:00");
        assert_eq!(smtp_port_default(), 465);
    }
}
