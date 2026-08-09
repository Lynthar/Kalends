use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde_json::Value;

use crate::{db, engine, Db};

#[derive(Clone)]
pub struct TelegramCfg {
    pub bot_token: String,
    pub chat_id: String,
    pub proxy: String,
}

#[derive(Clone)]
pub struct EmailCfg {
    pub host: String,
    pub port: u16,
    pub starttls: bool,
    pub username: String,
    pub password: String,
    pub from: String,
    pub to: String,
}

pub fn telegram_cfg(conn: &Connection) -> Option<TelegramCfg> {
    let v: Value = serde_json::from_str(&db::get_setting(conn, "notify.telegram")?).ok()?;
    if !v["enabled"].as_bool().unwrap_or(false) {
        return None;
    }
    let cfg = TelegramCfg {
        bot_token: v["bot_token"].as_str().unwrap_or("").trim().to_string(),
        chat_id: v["chat_id"].as_str().unwrap_or("").trim().to_string(),
        proxy: v["proxy"].as_str().unwrap_or("").trim().to_string(),
    };
    (!cfg.bot_token.is_empty() && !cfg.chat_id.is_empty()).then_some(cfg)
}

pub fn email_cfg(conn: &Connection) -> Option<EmailCfg> {
    let v: Value = serde_json::from_str(&db::get_setting(conn, "notify.email")?).ok()?;
    if !v["enabled"].as_bool().unwrap_or(false) {
        return None;
    }
    let cfg = EmailCfg {
        host: v["host"].as_str().unwrap_or("").trim().to_string(),
        port: v["port"].as_u64().unwrap_or(465) as u16,
        starttls: v["starttls"].as_bool().unwrap_or(false),
        username: v["username"].as_str().unwrap_or("").trim().to_string(),
        password: v["password"].as_str().unwrap_or("").to_string(),
        from: v["from"].as_str().unwrap_or("").trim().to_string(),
        to: v["to"].as_str().unwrap_or("").trim().to_string(),
    };
    (!cfg.host.is_empty() && !cfg.from.is_empty() && !cfg.to.is_empty()).then_some(cfg)
}

/// 出网请求（Telegram 与 TMDB 共用）。**必须带超时**：reqwest 默认既没有连接超时
/// 也没有总超时，而通知调度器是一条条顺序 await 的——一根挂死的连接能把之后所有提醒
/// 拖到下次重启，日志里还什么都看不到。
pub fn http_client(proxy: &str) -> Result<reqwest::Client> {
    build_client(proxy, true)
}

/// 不自动跟重定向的客户端。取图标那条路要自己一跳一跳地跟，好在每一跳都重新校验目标——
/// 交给 reqwest 自动跟的话，`https://正常站/x → 302 → http://10.0.0.5/` 就绕过了内网防线。
pub fn http_client_no_redirect(proxy: &str) -> Result<reqwest::Client> {
    build_client(proxy, false)
}

fn build_client(proxy: &str, follow: bool) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30)) // 含响应体，海报下载也走这条
        .redirect(if follow {
            reqwest::redirect::Policy::default()
        } else {
            reqwest::redirect::Policy::none()
        });
    if !proxy.is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(proxy)?);
    }
    Ok(builder.build()?)
}

pub async fn send_telegram(cfg: &TelegramCfg, text: &str) -> Result<()> {
    let client = http_client(&cfg.proxy)?;
    let resp = client
        .post(format!(
            "https://api.telegram.org/bot{}/sendMessage",
            cfg.bot_token
        ))
        .json(&serde_json::json!({ "chat_id": cfg.chat_id, "text": text }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "telegram {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(())
}

pub async fn send_email(cfg: &EmailCfg, subject: &str, body: &str) -> Result<()> {
    use lettre::message::header::ContentType;
    use lettre::message::Mailbox;
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let msg = Message::builder()
        .from(cfg.from.parse::<Mailbox>()?)
        .to(cfg.to.parse::<Mailbox>()?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_string())?;
    let builder = if cfg.starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)?
    };
    // 用户名为空就别带凭据：无认证的内网中继会拒绝空 AUTH
    let builder = builder.port(cfg.port);
    let transport = if cfg.username.is_empty() {
        builder.build()
    } else {
        builder
            .credentials(Credentials::new(cfg.username.clone(), cfg.password.clone()))
            .build()
    };
    transport.send(msg).await?;
    Ok(())
}

/// 单条到期项的通知文案。
pub fn line(it: &Value) -> String {
    let days = it["days_left"].as_i64().unwrap_or(0);
    let when = if days > 0 {
        format!("{days} 天后到期")
    } else if days == 0 {
        "今天到期".to_string()
    } else {
        format!("已过期 {} 天", -days)
    };
    let name = it["name"].as_str().unwrap_or("");
    let due = it["due"].as_str().unwrap_or("");
    let mut extra = String::new();
    if let (Some(p), Some(c)) = (it["price"].as_f64(), it["currency"].as_str()) {
        extra.push_str(&format!("，{c} {p:.2}"));
    }
    if let Some(a) = it["action"].as_str() {
        if !a.is_empty() {
            // 说法由库给（SIM 是"保号"、证件是"换证"），别再按类型写死
            extra.push_str(&format!("，{}：{a}", it["verb"].as_str().unwrap_or("续费")));
        }
    }
    format!("{when}（{due}）：{name}{extra}")
}

struct Pending {
    kind: String,
    item_id: Option<i64>,
    channel: &'static str,
    threshold: Option<i64>,
    covered: Vec<i64>,
    due: String,
    subject: String,
    text: String,
}

fn already_sent(
    conn: &Connection,
    kind: &str,
    item_id: i64,
    due: &str,
    threshold: i64,
    channel: &str,
) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM notification_log
         WHERE kind=?1 AND item_id=?2 AND due_date=?3 AND threshold_days=?4 AND channel=?5 AND ok=1)",
        params![kind, item_id, due, threshold, channel],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n == 1)
    .unwrap_or(false)
}

/// 摘要时刻，恒为零填充的 `HH:MM`。
///
/// 判断"到点了吗"是拿 `%H:%M` 的当前时刻做**字符串**比较，所以一个没零填充的
/// `"9:00"` 会让 `"09:00" >= "9:00"` 乃至 `"23:59" >= "9:00"` 全为假——摘要从此永不
/// 触发，且界面上看不出任何异常。界面的 `<input type=time>` 按规范写不出这种值，
/// 但设置接口收任意字符串，所以在读出口这里补齐。
fn digest_at(conn: &Connection) -> String {
    normalize_hhmm(&db::get_setting(conn, "notify.digest_time").unwrap_or_default())
}

fn normalize_hhmm(raw: &str) -> String {
    let mut parts = raw.trim().split(':');
    match (
        parts.next().and_then(|h| h.trim().parse::<u32>().ok()),
        parts.next().and_then(|m| m.trim().parse::<u32>().ok()),
    ) {
        (Some(h), Some(m)) if h < 24 && m < 60 => format!("{h:02}:{m:02}"),
        _ => "09:00".into(),
    }
}

fn digest_sent(conn: &Connection, today: &str, channel: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM notification_log
         WHERE kind='digest' AND due_date=?1 AND channel=?2 AND ok=1)",
        params![today, channel],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n == 1)
    .unwrap_or(false)
}

/// 检查一轮：逐项阈值提醒（补发折叠为一条）+ 每日摘要。
pub async fn tick(db: &Db) -> Result<()> {
    let (pendings, tg, mail) = {
        let conn = db.lock().unwrap();
        let tg = telegram_cfg(&conn);
        let mail = email_cfg(&conn);
        if tg.is_none() && mail.is_none() {
            return Ok(());
        }
        let thresholds: Vec<i64> = db::get_setting(&conn, "notify.thresholds")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| vec![14, 7, 3, 1, 0]);
        let window: i64 = db::get_setting(&conn, "notify.window_days")
            .and_then(|s| s.parse().ok())
            .unwrap_or(14);
        let digest_time = digest_at(&conn);
        let now_hhmm = chrono::Local::now().format("%H:%M").to_string();
        let today = engine::today().to_string();
        let ups = engine::upcoming(&conn)?;

        let mut channels: Vec<&'static str> = Vec::new();
        if tg.is_some() {
            channels.push("telegram");
        }
        if mail.is_some() {
            channels.push("email");
        }

        let mut pendings: Vec<Pending> = Vec::new();
        for ch in &channels {
            for it in &ups {
                if it["muted"].as_bool().unwrap_or(false) {
                    continue;
                }
                let days = it["days_left"].as_i64().unwrap_or(i64::MAX);
                let due = it["due"].as_str().unwrap_or("").to_string();
                let kind = it["kind"].as_str().unwrap_or("").to_string();
                let id = it["id"].as_i64().unwrap_or(0);
                let mut qualifying: Vec<i64> = thresholds
                    .iter()
                    .copied()
                    .filter(|t| days <= *t)
                    .filter(|t| !already_sent(&conn, &kind, id, &due, *t, ch))
                    .collect();
                if qualifying.is_empty() {
                    continue;
                }
                qualifying.sort();
                pendings.push(Pending {
                    kind,
                    item_id: Some(id),
                    channel: ch,
                    threshold: Some(qualifying[0]),
                    covered: qualifying[1..].to_vec(),
                    due,
                    subject: format!("Kalends：{}", line(it)),
                    text: format!("Kalends 提醒\n{}", line(it)),
                });
            }
            if now_hhmm.as_str() >= digest_time.as_str() && !digest_sent(&conn, &today, ch) {
                let due_items: Vec<&Value> = ups
                    .iter()
                    .filter(|i| i["days_left"].as_i64().unwrap_or(i64::MAX) <= window)
                    .collect();
                if !due_items.is_empty() {
                    let body = due_items
                        .iter()
                        .map(|i| format!("· {}", line(i)))
                        .collect::<Vec<_>>()
                        .join("\n");
                    pendings.push(Pending {
                        kind: "digest".into(),
                        item_id: None,
                        channel: ch,
                        threshold: None,
                        covered: Vec::new(),
                        due: today.clone(),
                        subject: format!("Kalends 摘要：{} 项即将到期", due_items.len()),
                        text: format!("Kalends 摘要（{today}）\n{body}"),
                    });
                }
            }
        }
        (pendings, tg, mail)
    };

    let mut results = Vec::new();
    for p in pendings {
        let res = match p.channel {
            "telegram" => send_telegram(tg.as_ref().unwrap(), &p.text).await,
            _ => send_email(mail.as_ref().unwrap(), &p.subject, &p.text).await,
        };
        results.push((p, res));
    }

    let conn = db.lock().unwrap();
    for (p, res) in results {
        let (ok, err) = match &res {
            Ok(()) => (1i64, None),
            Err(e) => (0i64, Some(format!("{e:#}"))),
        };
        if let Err(e) = &res {
            tracing::warn!("notify {} failed: {e:#}", p.channel);
        }
        conn.execute(
            "INSERT INTO notification_log(kind,item_id,channel,threshold_days,due_date,ok,error)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![p.kind, p.item_id, p.channel, p.threshold, p.due, ok, err],
        )?;
        if ok == 1 {
            for t in p.covered {
                conn.execute(
                    "INSERT INTO notification_log(kind,item_id,channel,threshold_days,due_date,ok,error)
                     VALUES(?1,?2,?3,?4,?5,1,'covered')",
                    params![p.kind, p.item_id, p.channel, t, p.due],
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 到点判定是字符串比较，所以「9:00」这种没零填充的值会让摘要永不触发
    //（"09:00" >= "9:00" 与 "23:59" >= "9:00" 都是假），且界面上看不出异常。
    #[test]
    fn digest_time_is_zero_padded_or_falls_back() {
        assert_eq!(normalize_hhmm("09:00"), "09:00");
        assert_eq!(normalize_hhmm("9:00"), "09:00");
        assert_eq!(normalize_hhmm(" 7:5 "), "07:05");
        assert_eq!(normalize_hhmm("23:59"), "23:59");
        // 越界与写不成样子的一律回落到默认，不留下一个永不触发的值
        assert_eq!(normalize_hhmm("24:00"), "09:00");
        assert_eq!(normalize_hhmm("12:60"), "09:00");
        assert_eq!(normalize_hhmm("每天早上"), "09:00");
        assert_eq!(normalize_hhmm(""), "09:00");
        // 规范化过的值拿来做字符串比较，一天里任何时刻都能正确判定
        let at = normalize_hhmm("9:00");
        assert!("09:00" >= at.as_str());
        assert!("23:59" >= at.as_str());
        assert!("08:59" < at.as_str());
    }

    #[test]
    fn line_reads_naturally_for_each_tense() {
        let base = |days: i64| json!({ "days_left": days, "name": "Netflix", "due": "2026-08-01" });
        assert!(line(&base(3)).starts_with("3 天后到期"));
        assert!(line(&base(0)).starts_with("今天到期"));
        assert!(line(&base(-5)).starts_with("已过期 5 天"));
    }

    #[test]
    fn line_uses_the_collection_verb_not_a_hardcoded_one() {
        // 泛化之前这里写死成「保号」，证件库的提醒会说"保号：换证材料"
        let it = json!({
            "days_left": 7, "name": "护照", "due": "2026-08-07",
            "verb": "换证", "action": "带旧证与照片",
        });
        assert!(line(&it).contains("换证：带旧证与照片"), "{}", line(&it));
        // 没给说法时回落到"续费"
        let noverb = json!({ "days_left": 7, "name": "x", "due": "2026-08-07", "action": "做点什么" });
        assert!(line(&noverb).contains("续费：做点什么"));
    }

    #[test]
    fn line_includes_price_only_when_both_parts_are_there() {
        let full = json!({ "days_left": 1, "name": "x", "due": "2026-08-01", "price": 15.5, "currency": "USD" });
        assert!(line(&full).contains("USD 15.50"));
        let half = json!({ "days_left": 1, "name": "x", "due": "2026-08-01", "price": 15.5 });
        assert!(!line(&half).contains("15.50"));
    }
}

pub async fn scheduler(db: Db) {
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    loop {
        if let Err(e) = tick(&db).await {
            tracing::warn!("notify tick failed: {e:#}");
        }
        tokio::time::sleep(std::time::Duration::from_secs(900)).await;
    }
}
