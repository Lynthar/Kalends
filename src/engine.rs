use std::collections::BTreeMap;

use anyhow::Result;
use chrono::{Days, Local, Months, NaiveDate};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// 从某个到期日按周期前进 n 期；lifetime 或未知周期返回 None。
///
/// **一定要一次性前进 n 期，不能循环调用 `advance` n 次。** 月加法会把日期钳到月末，
/// 而钳过之后锚点就丢了：1/31 迭代六次得 7/28，一次性加六个月才是 7/31。补推逾期条目
/// （`renew_item`）正是要跨多期的场景，用迭代会把用户的账单日一点点往前拽。
pub fn advance_n(date: NaiveDate, cycle: &str, cycle_days: Option<i64>, n: u32) -> Option<NaiveDate> {
    let months = |m: u32| date.checked_add_months(Months::new(m * n));
    let days = |d: u64| date.checked_add_days(Days::new(d * n as u64));
    match cycle {
        "weekly" => days(7),
        "monthly" => months(1),
        "quarterly" => months(3),
        "semiannual" => months(6),
        "annual" => months(12),
        "biennial" => months(24),
        "triennial" => months(36),
        "days" => cycle_days.filter(|d| *d > 0).and_then(|d| days(d as u64)),
        _ => None,
    }
}

/// 从某个到期日按周期前进一步。
pub fn advance(date: NaiveDate, cycle: &str, cycle_days: Option<i64>) -> Option<NaiveDate> {
    advance_n(date, cycle, cycle_days, 1)
}

/// 到期日的唯一实现：库按 due_anchor 决定是直接读下次续费日，还是从上次续费推一期。
/// 到期时间线（engine）与库列表（collections::due_of）都走这里——曾经是两份逐行等价的
/// 拷贝，改一处忘另一处就会让表格和到期栏各说各话。
pub fn due_from(
    anchor: &str,
    cycle: &str,
    cycle_days: Option<i64>,
    next_renewal: Option<&str>,
    last_renewed: Option<&str>,
) -> Option<NaiveDate> {
    if cycle == "lifetime" {
        return None;
    }
    let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
    if anchor == "next" {
        return next_renewal.and_then(day);
    }
    advance(last_renewed.and_then(day)?, cycle, cycle_days)
}

/// 折算为"每月几倍"的系数，用于分币种月支出；不可折算（买断等）返回 None。
pub fn monthly_factor(cycle: &str, cycle_days: Option<i64>) -> Option<f64> {
    match cycle {
        "weekly" => Some(30.44 / 7.0),
        "monthly" => Some(1.0),
        "quarterly" => Some(1.0 / 3.0),
        "semiannual" => Some(1.0 / 6.0),
        "annual" => Some(1.0 / 12.0),
        "biennial" => Some(1.0 / 24.0),
        "triennial" => Some(1.0 / 36.0),
        "days" => cycle_days.filter(|d| *d > 0).map(|d| 30.44 / d as f64),
        _ => None,
    }
}

pub fn cycle_label(cycle: &str, cycle_days: Option<i64>) -> String {
    match cycle {
        "weekly" => "Weekly".into(),
        "monthly" => "Monthly".into(),
        "quarterly" => "Quarterly".into(),
        "semiannual" => "Semiannual".into(),
        "annual" => "Annual".into(),
        "biennial" => "Biennial".into(),
        "triennial" => "Triennial".into(),
        "lifetime" => "Lifetime".into(),
        "days" => format!("Every {} days", cycle_days.unwrap_or(0)),
        other => other.into(),
    }
}

/// 状态的三层语义：计不计支出 / 发不发提醒 / 上不上到期时间线。
/// 以前这三件事散在各表的 SQL 字面量里（`status='Active'`、`IN ('Active','Ending')`），
/// 现在以各库状态词表里的选项标记为准（见 `sem_map`），读不到就回落到内置六值的既有含义。
#[derive(Clone, Copy)]
pub struct StatusSem {
    pub spend: bool,
    pub alert: bool,
    pub timeline: bool,
}

pub fn status_sem(status: &str) -> StatusSem {
    let (spend, alert, timeline) = match status {
        "Active" => (true, true, true),
        // 到期不续：时间线与日历仍可见，但不提醒、不计支出
        "Ending" => (false, false, true),
        // Planned 计划中 / Deferred 比价目录 / Unused 未启用 / Ended 已结束
        _ => (false, false, false),
    };
    StatusSem {
        spend,
        alert,
        timeline,
    }
}

/// 各库状态词表里的语义标记：库键 → 状态值 → 语义。用户在选项浮层里改的就是这份。
type SemMap = std::collections::HashMap<String, std::collections::HashMap<String, StatusSem>>;

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        Some(Value::String(s)) => !s.is_empty() && s != "0" && s != "false",
        _ => false,
    }
}

fn sem_map(conn: &Connection) -> Result<SemMap> {
    let mut out: SemMap = Default::default();
    let mut stmt = conn.prepare("SELECT tbl,options FROM fields WHERE key='status'")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (tbl, options) = row?;
        let Ok(Value::Array(opts)) = serde_json::from_str::<Value>(&options) else {
            continue;
        };
        let mut m = std::collections::HashMap::new();
        for o in opts {
            let Some(v) = o.get("v").and_then(|v| v.as_str()) else { continue };
            // 没带标记的选项（例如用户手加的状态）按内置默认理解，不是一律无语义
            let has_flags = ["spend", "alert", "timeline"].iter().any(|f| o.get(*f).is_some());
            let sem = if has_flags {
                StatusSem {
                    spend: truthy(o.get("spend")),
                    alert: truthy(o.get("alert")),
                    timeline: truthy(o.get("timeline")),
                }
            } else {
                status_sem(v)
            };
            m.insert(v.to_string(), sem);
        }
        out.insert(tbl, m);
    }
    Ok(out)
}

fn sem_of(map: &SemMap, coll: &str, status: &str) -> StatusSem {
    map.get(coll)
        .and_then(|m| m.get(status))
        .copied()
        .unwrap_or_else(|| status_sem(status))
}

/// 一个条目在到期时间线上的样子；跨库统一，engine 之外只认这个形状。
struct Row {
    key: String,
    verb: String,
    note_field: Option<String>,
    subtitle: Option<String>,
    id: i64,
    name: String,
    status: String,
    price: Option<f64>,
    currency: Option<String>,
    cycle: Option<String>,
    cycle_days: Option<i64>,
    next_renewal: Option<String>,
    last_renewed: Option<String>,
    due_anchor: String,
    extra: Value,
}

impl Row {
    /// 到期日：库按 due_anchor 决定是直接读下次续费日，还是从上次续费按周期推。
    fn due(&self) -> Option<NaiveDate> {
        due_from(
            &self.due_anchor,
            self.cycle.as_deref().unwrap_or(""),
            self.cycle_days,
            self.next_renewal.as_deref(),
            self.last_renewed.as_deref(),
        )
    }

    /// 显示名：库配了副标题字段且该条目有值时拼上（VPS 的"商家 · 产品"）。
    fn title(&self) -> String {
        let sub = self
            .subtitle
            .as_deref()
            .and_then(|k| self.extra.get(k))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        // 空名是允许的（表尾「＋ 新建」先插空行再就地填），但到期时间线、通知与 ICS 的
        // 标题不能因此变成空串——日历里那会是一个没有名字的事件。
        let name = if self.name.trim().is_empty() { "未命名" } else { self.name.trim() };
        match sub {
            Some(s) => format!("{name} · {s}"),
            None => name.to_string(),
        }
    }
}

fn rows(conn: &Connection) -> Result<Vec<Row>> {
    let mut stmt = conn.prepare(
        "SELECT c.key, c.verb, c.note_field, c.subtitle, c.due_anchor,
                i.id, i.name, i.status, i.price, i.currency, i.cycle, i.cycle_days,
                i.next_renewal, i.last_renewed, i.extra
         FROM items i JOIN collections c ON c.id = i.collection_id
         ORDER BY c.pos, i.id",
    )?;
    let out = stmt
        .query_map([], |r| {
            let extra: Option<String> = r.get(14)?;
            Ok(Row {
                key: r.get(0)?,
                verb: r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "续费".into()),
                note_field: r.get(2)?,
                subtitle: r.get(3)?,
                due_anchor: r.get(4)?,
                id: r.get(5)?,
                name: r.get(6)?,
                status: r.get(7)?,
                price: r.get(8)?,
                currency: r.get(9)?,
                cycle: r.get(10)?,
                cycle_days: r.get(11)?,
                next_renewal: r.get(12)?,
                last_renewed: r.get(13)?,
                extra: crate::api::extra_json(extra),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

/// 该上时间线、却算不出到期日的条目。
///
/// 这些条目状态是在管的（Active 之类），但缺 `next_renewal` 或 `last_renewed`，
/// `due_from` 给不出日期——于是它们既不在到期时间线上、也不进 ICS、更不会提醒。
/// 以前是直接 `continue` 掉：一个以"别忘了续费"为职责的工具，把算不出日期的条目
/// 从列表里悄悄拿掉，比显示错误更糟。这里单独列出来交给界面点名。
pub fn undated(conn: &Connection) -> Result<Vec<Value>> {
    let sems = sem_map(conn)?;
    let mut out = Vec::new();
    for r in rows(conn)? {
        if !sem_of(&sems, &r.key, &r.status).timeline || r.due().is_some() {
            continue;
        }
        // 买断（lifetime）本就没有到期日，不算欠缺
        if r.cycle.as_deref() == Some("lifetime") {
            continue;
        }
        let anchor_field = if r.due_anchor == "next" { "下次续费日" } else { "上次续费日" };
        out.push(json!({
            "kind": r.key,
            "id": r.id,
            "name": r.title(),
            "status": r.status,
            "missing": anchor_field,
        }));
    }
    Ok(out)
}

/// 合并到期时间线：所有库里状态语义为"上时间线"的条目，按到期日升序。
pub fn upcoming(conn: &Connection) -> Result<Vec<Value>> {
    let t = today();
    let sems = sem_map(conn)?;
    let mut items: Vec<(NaiveDate, Value)> = Vec::new();
    for r in rows(conn)? {
        let sem = sem_of(&sems, &r.key, &r.status);
        if !sem.timeline {
            continue;
        }
        let Some(due) = r.due() else { continue };
        let note = r
            .note_field
            .as_deref()
            .and_then(|k| r.extra.get(k))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        items.push((
            due,
            json!({
                "kind": r.key,
                "id": r.id,
                "name": r.title(),
                "verb": r.verb,
                "due": due.to_string(),
                "days_left": (due - t).num_days(),
                "price": r.price,
                "currency": r.currency,
                "cycle": cycle_label(r.cycle.as_deref().unwrap_or(""), r.cycle_days),
                "action": note,
                // 不提醒但仍显示的状态（Ending）在前端与通知里都要能识别
                "muted": !sem.alert,
            }),
        ));
    }
    items.sort_by_key(|(d, _)| *d);
    Ok(items.into_iter().map(|(_, v)| v).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn row(name: &str, subtitle: Option<&str>, extra: Value) -> Row {
        Row {
            key: "subs".into(),
            verb: String::new(),
            note_field: None,
            subtitle: subtitle.map(str::to_string),
            id: 1,
            name: name.into(),
            status: "Active".into(),
            price: None,
            currency: None,
            cycle: None,
            cycle_days: None,
            next_renewal: None,
            last_renewed: None,
            due_anchor: "next".into(),
            extra,
        }
    }

    // 空名条目是允许的（表尾「＋ 新建」先插空行再就地填），但到期时间线、通知与 ICS
    // 的标题不能因此变成空串——日历里那会是一个没有名字的事件
    #[test]
    fn title_falls_back_when_the_name_is_blank() {
        assert_eq!(row("Netflix", None, json!({})).title(), "Netflix");
        assert_eq!(row("", None, json!({})).title(), "未命名");
        assert_eq!(row("   ", None, json!({})).title(), "未命名");
        // 副标题照拼，前半段换成占位
        let with_sub = row("", Some("product"), json!({ "product": "VPS-1" }));
        assert_eq!(with_sub.title(), "未命名 · VPS-1");
        assert_eq!(
            row("HostA", Some("product"), json!({ "product": "VPS-1" })).title(),
            "HostA · VPS-1"
        );
    }

    #[test]
    fn advance_clamps_month_end() {
        // 1/31 加一个月落在 2 月最后一天，而且从此固定在 28/29 号——月末订阅会这样漂移一次
        assert_eq!(advance(d("2026-01-31"), "monthly", None), Some(d("2026-02-28")));
        assert_eq!(advance(d("2024-01-31"), "monthly", None), Some(d("2024-02-29")));
        assert_eq!(advance(d("2026-02-28"), "monthly", None), Some(d("2026-03-28")));
        assert_eq!(advance(d("2026-03-31"), "quarterly", None), Some(d("2026-06-30")));
    }

    #[test]
    fn advance_spans_years() {
        assert_eq!(advance(d("2026-12-15"), "monthly", None), Some(d("2027-01-15")));
        assert_eq!(advance(d("2024-02-29"), "annual", None), Some(d("2025-02-28")));
        assert_eq!(advance(d("2026-01-01"), "triennial", None), Some(d("2029-01-01")));
    }

    #[test]
    fn advance_custom_days_needs_a_positive_count() {
        assert_eq!(advance(d("2026-01-01"), "days", Some(181)), Some(d("2026-07-01")));
        // 天数缺失或非正：推不出日期，宁可没有到期日也不要一个错的
        assert_eq!(advance(d("2026-01-01"), "days", None), None);
        assert_eq!(advance(d("2026-01-01"), "days", Some(0)), None);
        assert_eq!(advance(d("2026-01-01"), "days", Some(-30)), None);
    }

    #[test]
    fn advance_has_no_next_for_lifetime_or_unknown() {
        assert_eq!(advance(d("2026-01-01"), "lifetime", None), None);
        assert_eq!(advance(d("2026-01-01"), "", None), None);
        assert_eq!(advance(d("2026-01-01"), "fortnightly", None), None);
    }

    #[test]
    fn monthly_factor_matches_cycle_length() {
        assert_eq!(monthly_factor("monthly", None), Some(1.0));
        assert_eq!(monthly_factor("annual", None), Some(1.0 / 12.0));
        assert_eq!(monthly_factor("triennial", None), Some(1.0 / 36.0));
        // 自定义天数按 30.44 天一个月折算
        let f = monthly_factor("days", Some(181)).unwrap();
        assert!((f - 30.44 / 181.0).abs() < 1e-12, "{f}");
        // 买断与残缺周期不参与支出统计，而不是当成 0 或 1
        assert_eq!(monthly_factor("lifetime", None), None);
        assert_eq!(monthly_factor("days", None), None);
        assert_eq!(monthly_factor("days", Some(0)), None);
    }

    #[test]
    fn status_semantics_for_builtin_values() {
        let a = status_sem("Active");
        assert!(a.spend && a.alert && a.timeline);
        // 到期不续：还在时间线与日历上，但不提醒也不计支出
        let e = status_sem("Ending");
        assert!(!e.spend && !e.alert && e.timeline);
        for s in ["Planned", "Deferred", "Unused", "Ended"] {
            let x = status_sem(s);
            assert!(!x.spend && !x.alert && !x.timeline, "{s}");
        }
        // 用户自加的状态默认三项全关，engine 不会凭空给它语义
        let n = status_sem("待寄回");
        assert!(!n.spend && !n.alert && !n.timeline);
    }

    #[test]
    fn cycle_label_is_english_with_day_count() {
        assert_eq!(cycle_label("semiannual", None), "Semiannual");
        assert_eq!(cycle_label("days", Some(181)), "Every 181 days");
        // 存储键不认识时原样回显，别把它吞成空字符串
        assert_eq!(cycle_label("weird", None), "weird");
    }

    /// 补推逾期条目必须一次性推 n 期。逐次调用 `advance` 会在月末被钳一次之后
    /// 永久丢掉锚点：1/31 迭代六次得 7/28，而正确答案是 7/31。
    #[test]
    fn advancing_many_periods_keeps_the_month_end_anchor() {
        let start = d("2026-01-31");
        let mut walked = start;
        for _ in 0..6 {
            walked = advance(walked, "monthly", None).unwrap();
        }
        assert_eq!(walked, d("2026-07-28"), "逐步推进会丢锚点（这正是不能那么做的理由）");
        assert_eq!(advance_n(start, "monthly", None, 6).unwrap(), d("2026-07-31"));
        // 短月仍然钳位，只是不把钳过的结果当成下一次的起点
        assert_eq!(advance_n(start, "monthly", None, 1).unwrap(), d("2026-02-28"));
        // 天数与周是绝对的，n 期就是 n 倍
        assert_eq!(advance_n(d("2026-01-01"), "days", Some(181), 2).unwrap(), d("2026-12-29")); // 362 天
        assert_eq!(advance_n(d("2026-01-01"), "weekly", None, 3).unwrap(), d("2026-01-22"));
        // 闰日按年推进：非闰年钳到 28，四年后回到 29
        assert_eq!(advance_n(d("2028-02-29"), "annual", None, 1).unwrap(), d("2029-02-28"));
        assert_eq!(advance_n(d("2028-02-29"), "annual", None, 4).unwrap(), d("2032-02-29"));
        assert_eq!(advance_n(d("2026-01-01"), "lifetime", None, 2), None);
    }

    /// 到期日只有一份实现，到期时间线与库列表都走它。
    #[test]
    fn due_is_computed_one_way_for_both_anchors() {
        assert_eq!(due_from("next", "annual", None, Some("2026-09-01"), None), Some(d("2026-09-01")));
        assert_eq!(due_from("last", "days", Some(181), None, Some("2026-01-01")), Some(d("2026-07-01")));
        // 买断没有到期日
        assert_eq!(due_from("next", "lifetime", None, Some("2026-09-01"), None), None);
        // 锚点字段缺了就算不出来——这些条目由 undated() 单独点名，而不是静默丢掉
        assert_eq!(due_from("next", "annual", None, None, Some("2026-01-01")), None);
        assert_eq!(due_from("last", "annual", None, Some("2026-09-01"), None), None);
        // last 锚点但周期为空：同样算不出来（SIM 曾因界面清掉 cycle 整条掉出时间线）
        assert_eq!(due_from("last", "", None, None, Some("2026-01-01")), None);
    }

}

/// 分币种月/年支出：状态语义为"计支出"且周期可折算的条目。
pub fn totals(conn: &Connection) -> Result<Vec<Value>> {
    let mut map: BTreeMap<String, f64> = BTreeMap::new();
    let sems = sem_map(conn)?;
    for r in rows(conn)? {
        if !sem_of(&sems, &r.key, &r.status).spend {
            continue;
        }
        let (Some(price), Some(currency)) = (r.price, r.currency.clone()) else {
            continue;
        };
        if let Some(f) = monthly_factor(r.cycle.as_deref().unwrap_or(""), r.cycle_days) {
            *map.entry(currency).or_insert(0.0) += price * f;
        }
    }
    Ok(map
        .into_iter()
        .map(|(c, m)| {
            json!({
                "currency": c,
                "monthly": (m * 100.0).round() / 100.0,
                "annual": (m * 12.0 * 100.0).round() / 100.0,
            })
        })
        .collect())
}
