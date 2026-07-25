use std::collections::BTreeMap;

use anyhow::Result;
use chrono::{Days, Local, Months, NaiveDate};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// 从某个到期日按周期前进一步；lifetime 或未知周期返回 None。
pub fn advance(date: NaiveDate, cycle: &str, cycle_days: Option<i64>) -> Option<NaiveDate> {
    match cycle {
        "weekly" => date.checked_add_days(Days::new(7)),
        "monthly" => date.checked_add_months(Months::new(1)),
        "quarterly" => date.checked_add_months(Months::new(3)),
        "semiannual" => date.checked_add_months(Months::new(6)),
        "annual" => date.checked_add_months(Months::new(12)),
        "biennial" => date.checked_add_months(Months::new(24)),
        "triennial" => date.checked_add_months(Months::new(36)),
        "days" => cycle_days
            .filter(|d| *d > 0)
            .and_then(|d| date.checked_add_days(Days::new(d as u64))),
        _ => None,
    }
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
        "weekly" => "周付".into(),
        "monthly" => "月付".into(),
        "quarterly" => "季付".into(),
        "semiannual" => "半年付".into(),
        "annual" => "年付".into(),
        "biennial" => "两年付".into(),
        "triennial" => "三年付".into(),
        "lifetime" => "买断".into(),
        "days" => format!("每 {} 天", cycle_days.unwrap_or(0)),
        other => other.into(),
    }
}

/// 合并到期时间线：订阅(Active) + SIM(启用)，按到期日升序。
pub fn upcoming(conn: &Connection) -> Result<Vec<Value>> {
    let t = today();
    let mut items: Vec<(NaiveDate, Value)> = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT id,name,price,currency,cycle,cycle_days,next_renewal FROM subscriptions
         WHERE status='Active' AND next_renewal IS NOT NULL AND ifnull(cycle,'')!='lifetime'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<f64>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, String>(6)?,
        ))
    })?;
    for row in rows {
        let (id, name, price, currency, cycle, cycle_days, next) = row?;
        if let Ok(due) = NaiveDate::parse_from_str(&next, "%Y-%m-%d") {
            items.push((
                due,
                json!({
                    "kind": "subscription",
                    "id": id,
                    "name": name,
                    "due": next,
                    "days_left": (due - t).num_days(),
                    "price": price,
                    "currency": currency,
                    "cycle": cycle_label(cycle.as_deref().unwrap_or(""), cycle_days),
                }),
            ));
        }
    }

    let mut stmt = conn.prepare(
        "SELECT id,name,keepalive_action,cycle_days,last_renewed FROM sim_cards
         WHERE status='启用' AND last_renewed IS NOT NULL AND ifnull(cycle_days,0)>0",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    for row in rows {
        let (id, name, action, cycle_days, last) = row?;
        let Ok(last) = NaiveDate::parse_from_str(&last, "%Y-%m-%d") else {
            continue;
        };
        let Some(due) = last.checked_add_days(Days::new(cycle_days as u64)) else {
            continue;
        };
        items.push((
            due,
            json!({
                "kind": "sim",
                "id": id,
                "name": name,
                "due": due.to_string(),
                "days_left": (due - t).num_days(),
                "action": action,
                "cycle": format!("每 {cycle_days} 天"),
            }),
        ));
    }

    let mut stmt = conn.prepare(
        "SELECT id,vendor,product,price,currency,cycle,cycle_days,last_renewed,status FROM vps_instances
         WHERE status IN ('启用','预结束') AND last_renewed IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<f64>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))
    })?;
    for row in rows {
        let (id, vendor, product, price, currency, cycle, cycle_days, last, status) = row?;
        let Ok(last) = NaiveDate::parse_from_str(&last, "%Y-%m-%d") else {
            continue;
        };
        let cy = cycle.as_deref().unwrap_or("");
        let Some(due) = advance(last, cy, cycle_days) else {
            continue;
        };
        let name = match product.filter(|p| !p.is_empty()) {
            Some(p) => format!("{vendor} · {p}"),
            None => vendor,
        };
        items.push((
            due,
            json!({
                "kind": "vps",
                "id": id,
                "name": name,
                "due": due.to_string(),
                "days_left": (due - t).num_days(),
                "price": price,
                "currency": currency,
                "cycle": cycle_label(cy, cycle_days),
                // 预结束 = 到期不续：时间线/日历可见，但不发提醒
                "muted": status == "预结束",
            }),
        ));
    }

    items.sort_by_key(|(d, _)| *d);
    Ok(items.into_iter().map(|(_, v)| v).collect())
}

/// 分币种月/年支出（仅 Active 且可折算的订阅）。
pub fn totals(conn: &Connection) -> Result<Vec<Value>> {
    let mut map: BTreeMap<String, f64> = BTreeMap::new();
    let sources = [
        "SELECT price,currency,cycle,cycle_days FROM subscriptions
         WHERE status='Active' AND price IS NOT NULL AND currency IS NOT NULL",
        "SELECT price,currency,cycle,cycle_days FROM vps_instances
         WHERE status='启用' AND price IS NOT NULL AND currency IS NOT NULL",
    ];
    for sql in sources {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, f64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        })?;
        for row in rows {
            let (price, currency, cycle, cycle_days) = row?;
            if let Some(f) = monthly_factor(cycle.as_deref().unwrap_or(""), cycle_days) {
                *map.entry(currency).or_insert(0.0) += price * f;
            }
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
