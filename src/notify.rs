use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::HashSet;

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
    build_client(proxy, true, None)
}

/// 不跟重定向、且把目标主机钉死在一个已校验地址上的客户端。
///
/// 取图标那条路要自己一跳一跳地跟（交给 reqwest 自动跟的话，
/// `https://正常站/x → 302 → http://10.0.0.5/` 就绕过了内网防线），
/// **并且每跳都得钉地址**：先解析校验、再让 reqwest 自己去解析一次的话，
/// 两次之间 DNS 可以翻脸（DNS rebinding / TOCTOU），校验过的和真正连上的就不是同一台机器。
/// `resolve` 只改地址，TLS 的 SNI 与证书校验仍按原主机名走。
pub fn http_client_pinned(proxy: &str, host: &str, addr: std::net::SocketAddr) -> Result<reqwest::Client> {
    build_client(proxy, false, Some((host, addr)))
}

fn build_client(
    proxy: &str,
    follow: bool,
    pin: Option<(&str, std::net::SocketAddr)>,
) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30)) // 含响应体，海报下载也走这条
        .redirect(if follow {
            reqwest::redirect::Policy::default()
        } else {
            reqwest::redirect::Policy::none()
        });
    if let Some((host, addr)) = pin {
        builder = builder.resolve(host, addr);
    }
    if !proxy.is_empty() {
        // 配了代理时域名由代理解析，钉地址不生效——那种部署的出口管控在代理侧
        builder = builder.proxy(reqwest::Proxy::all(proxy)?);
    }
    Ok(builder.build()?)
}

/// 整段读进来，累计超限就断开并报错（读完再判等于白读）。
///
/// **reqwest 没有默认上限**，唯一的边界是上面那 30s 总超时——也就是「带宽 × 30s」：
/// 千兆链路下最坏是数 GB 进到这个单二进制进程的内存里，而容器内存配额常只有几百 MB，
/// OOM kill 会把通知调度一起带走。取图标与 TMDB 图片都走它：图标那侧的目标是用户
/// 自己填的网址（可能被劫持），TMDB 那侧虽是可信源，但中间还隔着一层用户配的代理。
pub async fn body_capped(resp: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let too_big = || format!("响应体超过 {} KB", limit >> 10);
    if resp.content_length().is_some_and(|n| n > limit as u64) {
        return Err(too_big());
    }
    let mut resp = resp;
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取失败：{e}"))? {
        if out.len() + chunk.len() > limit {
            return Err(too_big());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
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

/// 发送渠道。
///
/// **是枚举而不是字符串**：发送分派是一个 `match`，加一种渠道时漏改它会**编译失败**。
/// 字符串版那个 `_ =>` catch-all 不会——新渠道会掉进邮件分支，`mail` 为 None 时
/// `unwrap` 直接 panic，而 `scheduler` 的重试循环在 `tick` 外面、只接得住 `Err` 接不住
/// panic：unwind 会带走整个后台任务，通知从此静默停止直到重启，HTTP 服务却一切正常。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Channel {
    Telegram,
    Email,
}

impl Channel {
    /// 落库与去重键里的写法，与 `notification_log.channel` 的历史取值一致。
    fn as_str(self) -> &'static str {
        match self {
            Channel::Telegram => "telegram",
            Channel::Email => "email",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "telegram" => Some(Channel::Telegram),
            "email" => Some(Channel::Email),
            _ => None, // 别的二进制写下的渠道（如将来的 discord），对本轮判断没有意义
        }
    }
}

#[derive(Debug)]
struct Pending {
    kind: String,
    item_id: Option<i64>,
    channel: Channel,
    threshold: Option<i64>,
    covered: Vec<i64>,
    due: String,
    subject: String,
    text: String,
}

/// 已经成功发出去的通知，去重用。含折叠补发时写下的 `covered` 行——它们同样是 `ok=1`，
/// 语义就是"这一档不必再发了"。
///
/// **一次查询载入，而不是在决策循环里逐条 `EXISTS`**：逐条是「项数 × 阈值数 × 渠道数」次
/// 查询，几十个条目就是几百次，全都发生在全局那把单连接锁里，而同一把锁挡着所有 HTTP
/// 请求。载入也让决策变成纯函数，那才是这一段唯一没有测试的地方。
#[derive(Default)]
struct SentLog {
    items: HashSet<(String, i64, String, i64, Channel)>,
    digests: HashSet<(String, Channel)>,
}

impl SentLog {
    /// `since` 是本轮关心的最早日期。**不能图省事全表载入**：`notification_log` 既没有
    /// 清理逻辑也没有读接口，只会随部署时间一直长。
    fn load(conn: &Connection, since: &str) -> Result<Self> {
        let mut out = Self::default();
        let mut st = conn.prepare(
            "SELECT kind, item_id, due_date, threshold_days, channel
             FROM notification_log WHERE ok=1 AND due_date >= ?1",
        )?;
        let rows = st.query_map(params![since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (kind, item_id, due, threshold, channel) = row?;
            let Some(ch) = Channel::from_str(&channel) else {
                continue;
            };
            // 摘要那半的 item_id 与 threshold 都是 NULL，两半分开存，键不会串味
            match (kind.as_str(), item_id, threshold) {
                ("digest", _, _) => {
                    out.digests.insert((due, ch));
                }
                (_, Some(id), Some(t)) => {
                    out.items.insert((kind, id, due, t, ch));
                }
                _ => {}
            }
        }
        Ok(out)
    }

    fn has_item(&self, kind: &str, id: i64, due: &str, threshold: i64, ch: Channel) -> bool {
        self.items
            .contains(&(kind.to_string(), id, due.to_string(), threshold, ch))
    }

    fn has_digest(&self, day: &str, ch: Channel) -> bool {
        self.digests.contains(&(day.to_string(), ch))
    }
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

/// 载入去重记录的下界。
///
/// 两半的 `due_date` 来路不同：逐项提醒记的是条目自己的到期日（**逾期项在过去，可能已经过去
/// 很久**），每日摘要记的是当天。取两者更早的那个——从今天切起就会把逾期项的记录挡在外面，
/// 它们于是每轮都被判成"没发过"，天天重发。
fn load_since(today: &str, ups: &[Value]) -> String {
    ups.iter()
        .filter_map(|it| it["due"].as_str())
        .fold(today, |acc, d| if d < acc { d } else { acc })
        .to_string()
}

/// 一轮检查的全部输入：都是已经读好的数据，不碰数据库也不看时钟。
struct TickInput<'a> {
    now_hhmm: &'a str,
    today: &'a str,
    digest_time: &'a str,
    thresholds: &'a [i64],
    window: i64,
    channels: &'a [Channel],
    ups: &'a [Value],
    sent: &'a SentLog,
}

/// 决定这一轮要发什么。
///
/// 通知语义里有三条**从代码直觉推不出来、改了却看不出异常**的规则，全在这个函数里，
/// 也全都由单测钉着：
///
/// ① **muted 项不发逐项提醒，但仍进每日摘要**。用户拍过板：摘要＝到期时间线的全景，
///    muted 只管"不单独推送"这一件事。补齐成"摘要也跳过"就是推翻拍板。
/// ② **补发折叠成一条**：够格的阈值里只发最紧迫的那个，其余记 `covered`。否则停机一周
///    后重启，同一个条目会按 14/7/3/1/0 一次刷五条出来。
/// ③ **逾期项只提醒一次**：`days <= t` 对负数满足所有档位，首轮一次发完记完；只要 `due`
///    不变去重键就不变，此后靠每日摘要。台账里长期挂着几项欠费是常态，改成"逾期就每天提醒"
///    等于每天按逾期项数刷屏。
fn plan(inp: &TickInput) -> Vec<Pending> {
    let mut out: Vec<Pending> = Vec::new();
    for &ch in inp.channels {
        for it in inp.ups {
            if it["muted"].as_bool().unwrap_or(false) {
                continue;
            }
            let days = it["days_left"].as_i64().unwrap_or(i64::MAX);
            let due = it["due"].as_str().unwrap_or("").to_string();
            let kind = it["kind"].as_str().unwrap_or("").to_string();
            let id = it["id"].as_i64().unwrap_or(0);
            let mut qualifying: Vec<i64> = inp
                .thresholds
                .iter()
                .copied()
                .filter(|t| days <= *t)
                .filter(|t| !inp.sent.has_item(&kind, id, &due, *t, ch))
                .collect();
            if qualifying.is_empty() {
                continue;
            }
            qualifying.sort();
            out.push(Pending {
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
        if inp.now_hhmm >= inp.digest_time && !inp.sent.has_digest(inp.today, ch) {
            let due_items: Vec<&Value> = inp
                .ups
                .iter()
                .filter(|i| i["days_left"].as_i64().unwrap_or(i64::MAX) <= inp.window)
                .collect();
            if !due_items.is_empty() {
                let body = due_items
                    .iter()
                    .map(|i| format!("· {}", line(i)))
                    .collect::<Vec<_>>()
                    .join("\n");
                let today = inp.today;
                out.push(Pending {
                    kind: "digest".into(),
                    item_id: None,
                    channel: ch,
                    threshold: None,
                    covered: Vec::new(),
                    due: today.to_string(),
                    subject: format!("Kalends 摘要：{} 项即将到期", due_items.len()),
                    text: format!("Kalends 摘要（{today}）\n{body}"),
                });
            }
        }
    }
    out
}

/// 检查一轮：读数据 → `plan` 决策 → 发送 → 落库。
pub async fn tick(db: &Db) -> Result<()> {
    let (pendings, tg, mail) = {
        let conn = db.lock().unwrap();
        let tg = telegram_cfg(&conn);
        let mail = email_cfg(&conn);
        let mut channels: Vec<Channel> = Vec::new();
        if tg.is_some() {
            channels.push(Channel::Telegram);
        }
        if mail.is_some() {
            channels.push(Channel::Email);
        }
        if channels.is_empty() {
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

        let sent = SentLog::load(&conn, &load_since(&today, &ups))?;

        let pendings = plan(&TickInput {
            now_hhmm: &now_hhmm,
            today: &today,
            digest_time: &digest_time,
            thresholds: &thresholds,
            window,
            channels: &channels,
            ups: &ups,
            sent: &sent,
        });
        (pendings, tg, mail)
    };

    let mut results = Vec::new();
    for p in pendings {
        // 渠道配置在决策之前就取好了，这里的 None 不可能发生；即便如此也别 unwrap——
        // 后台任务里的 panic 会静默掐掉整个调度循环，记一条失败日志便宜得多
        let res = match p.channel {
            Channel::Telegram => match &tg {
                Some(cfg) => send_telegram(cfg, &p.text).await,
                None => Err(anyhow!("telegram 渠道未配置")),
            },
            Channel::Email => match &mail {
                Some(cfg) => send_email(cfg, &p.subject, &p.text).await,
                None => Err(anyhow!("email 渠道未配置")),
            },
        };
        results.push((p, res));
    }

    let conn = db.lock().unwrap();
    for (p, res) in results {
        let (ok, err) = match &res {
            Ok(()) => (1i64, None),
            Err(e) => (0i64, Some(format!("{e:#}"))),
        };
        let channel = p.channel.as_str();
        if let Err(e) = &res {
            tracing::warn!("notify {channel} failed: {e:#}");
        }
        conn.execute(
            "INSERT INTO notification_log(kind,item_id,channel,threshold_days,due_date,ok,error)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![p.kind, p.item_id, channel, p.threshold, p.due, ok, err],
        )?;
        if ok == 1 {
            for t in p.covered {
                conn.execute(
                    "INSERT INTO notification_log(kind,item_id,channel,threshold_days,due_date,ok,error)
                     VALUES(?1,?2,?3,?4,?5,1,'covered')",
                    params![p.kind, p.item_id, channel, t, p.due],
                )?;
            }
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TH: [i64; 5] = [14, 7, 3, 1, 0];
    const TG: &[Channel] = &[Channel::Telegram];

    fn up(id: i64, days: i64, due: &str) -> Value {
        json!({ "kind": "subs", "id": id, "name": format!("条目{id}"), "due": due, "days_left": days })
    }

    fn muted(mut v: Value) -> Value {
        v["muted"] = json!(true);
        v
    }

    /// 摘要时刻恒为 09:00、窗口 14 天。`now` 传 "08:00" 就只剩逐项提醒那一半，
    /// 断言 `len()` 时不用先把摘要摘出去。
    fn plan_at(
        now: &str,
        today: &str,
        ups: &[Value],
        sent: &SentLog,
        chs: &[Channel],
    ) -> Vec<Pending> {
        plan(&TickInput {
            now_hhmm: now,
            today,
            digest_time: "09:00",
            thresholds: &TH,
            window: 14,
            channels: chs,
            ups,
            sent,
        })
    }

    /// 把「已经发过/已折叠」记进去。`covered` 行落库时同样是 `ok=1`，所以两者不分。
    fn mark(log: &mut SentLog, id: i64, due: &str, thresholds: &[i64], ch: Channel) {
        for t in thresholds {
            log.items.insert(("subs".into(), id, due.into(), *t, ch));
        }
    }

    // ── 阈值与折叠 ──────────────────────────────────────────────

    #[test]
    fn the_closest_threshold_is_sent_and_the_looser_ones_are_folded_in() {
        // 3 天后到期同时够格 14/7/3 三档。发最紧迫的那一档，另两档记 covered——
        // 逐档各发一条的话，停机几天后重启会一次刷屏。
        let p = plan_at("08:00", "2026-08-15", &[up(1, 3, "2026-08-18")], &SentLog::default(), TG);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].threshold, Some(3));
        assert_eq!(p[0].covered, vec![7, 14]);
    }

    #[test]
    fn the_next_reminder_carries_only_the_newly_qualifying_threshold() {
        // 上一轮把 3/7/14 都记了，今天进 1 档：只剩它一个够格，covered 应当是空的
        let mut sent = SentLog::default();
        mark(&mut sent, 1, "2026-08-18", &[3, 7, 14], Channel::Telegram);
        let p = plan_at("08:00", "2026-08-17", &[up(1, 1, "2026-08-18")], &sent, TG);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].threshold, Some(1));
        assert!(p[0].covered.is_empty());
    }

    #[test]
    fn an_overdue_item_is_announced_once_not_every_day() {
        // days<0 满足所有档位，首轮一次发完记完
        let first = plan_at("08:00", "2026-08-15", &[up(1, -5, "2026-08-10")], &SentLog::default(), TG);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].threshold, Some(0));
        assert_eq!(first[0].covered, vec![1, 3, 7, 14]);

        // 次日：同一个 due，去重键没变，应当彻底安静。长期欠费的条目本就常年挂着，
        // 这里松一格就是每天按逾期项数刷屏。
        let mut sent = SentLog::default();
        mark(&mut sent, 1, "2026-08-10", &TH, Channel::Telegram);
        assert!(plan_at("08:00", "2026-08-16", &[up(1, -6, "2026-08-10")], &sent, TG).is_empty());
    }

    #[test]
    fn renewing_moves_the_due_date_so_reminders_start_over() {
        // 去重键含 due：续费推到下一期之后，同一个条目要能重新提醒
        let mut sent = SentLog::default();
        mark(&mut sent, 1, "2026-08-10", &TH, Channel::Telegram);
        let p = plan_at("08:00", "2026-08-16", &[up(1, 3, "2026-09-10")], &sent, TG);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].due, "2026-09-10");
    }

    #[test]
    fn an_empty_threshold_list_turns_per_item_reminders_off_but_not_the_digest() {
        // 只想要每日摘要是合法配置，不该被回落成默认档位
        let ups = [up(1, 3, "2026-08-18")];
        let p = plan(&TickInput {
            now_hhmm: "09:30",
            today: "2026-08-15",
            digest_time: "09:00",
            thresholds: &[],
            window: 14,
            channels: TG,
            ups: &ups,
            sent: &SentLog::default(),
        });
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, "digest");
    }

    // ── muted（用户拍板，别"顺手补齐"）────────────────────────────

    #[test]
    fn a_muted_item_gets_no_reminder_of_its_own() {
        let ups = [muted(up(1, 3, "2026-08-18"))];
        assert!(plan_at("08:00", "2026-08-15", &ups, &SentLog::default(), TG).is_empty());
    }

    #[test]
    fn a_muted_item_still_shows_up_in_the_digest() {
        // 摘要＝到期时间线的全景，muted 只管"不单独推送"这一件事。用户明确拍过板，
        // 摘要那一半**没有**跳过 muted 的分支——补上就是推翻拍板。
        let ups = [muted(up(1, 3, "2026-08-18"))];
        let p = plan_at("09:30", "2026-08-15", &ups, &SentLog::default(), TG);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, "digest");
        assert!(p[0].text.contains("条目1"), "{}", p[0].text);
    }

    // ── 每日摘要 ────────────────────────────────────────────────

    #[test]
    fn the_digest_waits_for_its_hour() {
        let ups = [up(1, 3, "2026-08-18")];
        let p = plan_at("08:59", "2026-08-15", &ups, &SentLog::default(), TG);
        assert!(p.iter().all(|x| x.kind != "digest"));
    }

    #[test]
    fn the_digest_goes_out_once_a_day() {
        let mut sent = SentLog::default();
        sent.digests.insert(("2026-08-15".into(), Channel::Telegram));
        let ups = [up(1, 3, "2026-08-18")];
        // 09:00 之后每 15 分钟醒一次，没有这道去重就是每刻钟一封
        let p = plan_at("23:59", "2026-08-15", &ups, &sent, TG);
        assert!(p.iter().all(|x| x.kind != "digest"));
    }

    #[test]
    fn nothing_in_the_window_means_no_empty_digest() {
        let ups = [up(1, 20, "2026-09-04")];
        assert!(plan_at("09:30", "2026-08-15", &ups, &SentLog::default(), TG).is_empty());
    }

    #[test]
    fn the_digest_window_reaches_back_over_overdue_items() {
        // 窗口判据是 days_left <= window，负数自然在内：逾期项提醒过一次之后，
        // 每日摘要是它唯一还会露面的地方
        let mut sent = SentLog::default();
        mark(&mut sent, 1, "2026-08-10", &TH, Channel::Telegram);
        let ups = [up(1, -5, "2026-08-10")];
        let p = plan_at("09:30", "2026-08-15", &ups, &sent, TG);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, "digest");
        assert!(p[0].text.contains("已过期 5 天"), "{}", p[0].text);
    }

    #[test]
    fn the_dedup_window_starts_at_the_oldest_due_date_not_today() {
        // 逾期项的记录在过去，从今天切起会把它们挡在外面——那些项于是每轮都像"没发过"
        let ups = [up(1, -60, "2026-06-16"), up(2, 3, "2026-08-18")];
        assert_eq!(load_since("2026-08-15", &ups), "2026-06-16");
        // 没有条目、或全在未来时，摘要那半仍以今天记账，下界不能往后跑
        assert_eq!(load_since("2026-08-15", &[]), "2026-08-15");
        assert_eq!(load_since("2026-08-15", &[up(1, 3, "2026-08-18")]), "2026-08-15");
    }

    // ── 渠道 ────────────────────────────────────────────────────

    #[test]
    fn each_channel_is_decided_on_its_own() {
        let ups = [up(1, 3, "2026-08-18")];
        let both = &[Channel::Telegram, Channel::Email];
        let p = plan_at("08:00", "2026-08-15", &ups, &SentLog::default(), both);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].channel, Channel::Telegram);
        assert_eq!(p[1].channel, Channel::Email);
    }

    #[test]
    fn a_channel_that_already_got_it_is_skipped_while_the_other_still_gets_it() {
        // 去重键含渠道：Telegram 发成功、邮件那次失败（没写 ok=1），补的只能是邮件
        let mut sent = SentLog::default();
        mark(&mut sent, 1, "2026-08-18", &TH, Channel::Telegram);
        let ups = [up(1, 3, "2026-08-18")];
        let both = &[Channel::Telegram, Channel::Email];
        let p = plan_at("08:00", "2026-08-15", &ups, &sent, both);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].channel, Channel::Email);
    }

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
