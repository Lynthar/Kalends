//! 币种折算。**原币入账不变**（price/currency 永远存原币），折算只发生在呈现层、
//! 实现只有前端那一份；通知文案与 ICS 一律不折算。两个来源：内置平均汇率打底
//! （离线可用，脚本重写别手改），设置页手动拉的实时值盖上面。报价恒为「1 USD = N」。

use anyhow::Result;
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

use crate::db;

/// 内置平均汇率的取样区间，界面上要说清楚这份数字是什么时候的。
pub const BASELINE_PERIOD: &str = "2026-07-08 – 2026-08-06";

/// 1 USD = N 单位，取 `BASELINE_PERIOD` 区间内各交易日的均值。
/// 由 `scripts/update-fx-baseline.py` 重新生成——别手改，改了下次发版会被覆盖。
pub const BASELINE: &[(&str, f64)] = &[
    ("AUD", 1.4314),
    ("BRL", 5.1011),
    ("CAD", 1.408),
    ("CHF", 0.8113),
    ("CNY", 6.7687),
    ("CZK", 21.1603),
    ("DKK", 6.5348),
    ("EUR", 0.8742),
    ("GBP", 0.7464),
    ("HKD", 7.841),
    ("HUF", 315.7968),
    ("IDR", 18006.1364),
    ("ILS", 3.0378),
    ("INR", 95.8627),
    ("ISK", 124.9059),
    ("JPY", 161.7032),
    ("KRW", 1468.5132),
    ("MXN", 17.4311),
    ("MYR", 4.0852),
    ("NOK", 9.6377),
    ("NZD", 1.7197),
    ("PHP", 61.4879),
    ("PLN", 3.7779),
    ("RON", 4.5808),
    ("SEK", 9.6421),
    ("SGD", 1.2894),
    ("THB", 33.5082),
    ("TRY", 47.2464),
    ("USD", 1.0),
    ("ZAR", 16.4938),
];

/// 生效中的汇率表：内置表打底，实时值盖上面；`live` 单独记，界面要能说清哪些币种
/// 是实时值。折算不在这里做——整张表下发给前端，免得换算前后端各写一遍。
pub struct Rates {
    pub map: BTreeMap<String, f64>,
    pub live: Vec<String>,
}

fn baseline() -> BTreeMap<String, f64> {
    BASELINE.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

/// 读设置里存着的实时汇率，叠加到内置表上。
pub fn rates(conn: &Connection) -> Rates {
    let mut map = baseline();
    let mut live = Vec::new();
    let stored = db::get_setting(conn, "fx.rates").unwrap_or_default();
    if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&stored) {
        for (k, v) in obj {
            if let Some(x) = v.as_f64().filter(|x| *x > 0.0) {
                let code = k.trim().to_uppercase();
                live.push(code.clone());
                map.insert(code, x);
            }
        }
    }
    live.sort();
    Rates { map, live }
}

/// 显示币种；空串＝不折算，各币种原样分开呈现。
pub fn display_currency(conn: &Connection) -> String {
    db::get_setting(conn, "fx.display")
        .map(|s| s.trim().to_uppercase())
        .unwrap_or_default()
}

/// 给前端的一份完整状态：折算全在呈现层做，所以表和元信息都下发给它。
pub fn state(conn: &Connection) -> Value {
    let r = rates(conn);
    json!({
        "display": display_currency(conn),
        "rates": r.map,
        "live": r.live,
        "fetched_at": db::get_setting(conn, "fx.fetched_at").unwrap_or_default(),
        "baseline_period": BASELINE_PERIOD,
        "source": SOURCE_LABEL,
    })
}

pub const SOURCE_LABEL: &str = "欧洲央行参考汇率（Frankfurter）";
const SOURCE_URL: &str = "https://api.frankfurter.dev/v1/latest?base=USD";

/// 手动拉一次实时汇率：默认关着的出网，用户在设置页点一下才发生、不后台轮询。
/// 走 notify::http_client 带上超时与 meta.proxy。
pub async fn refresh(conn: &crate::Db) -> Result<Value> {
    let proxy = {
        let c = conn.lock().unwrap();
        db::get_setting(&c, "meta.proxy").unwrap_or_default()
    };
    let client = crate::notify::http_client(&proxy)?;
    // 显式带 UA：被 UA 规则拦掉时表现是 403 而不是网络错误，不带名号看不出所以然
    let resp = client
        .get(SOURCE_URL)
        .header(reqwest::header::USER_AGENT, "kalends")
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("汇率接口返回 {}", resp.status());
    }
    // 与 TMDB 同一条规矩：出网响应体一律封顶，超时管不住"读多少"
    let bytes = crate::notify::body_capped(resp, 1 << 20)
        .await
        .map_err(|e| anyhow::anyhow!("汇率接口{e}"))?;
    let body: Value = serde_json::from_slice(&bytes)?;
    let mut map = Map::new();
    // 接口给的是「1 USD = N 单位」，与内置表同一形状；USD 自己不在 rates 里
    map.insert("USD".into(), json!(1.0));
    for (k, v) in body.get("rates").and_then(|x| x.as_object()).into_iter().flatten() {
        if let Some(x) = v.as_f64().filter(|x| *x > 0.0) {
            map.insert(k.trim().to_uppercase(), json!(x));
        }
    }
    if map.len() < 2 {
        anyhow::bail!("汇率接口没给出任何可用报价");
    }
    let stamp = body
        .get("date")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    {
        let c = conn.lock().unwrap();
        let tx = c.unchecked_transaction()?;
        // 两个键要么一起写进去，要么都不写——只落了汇率没落时间戳，界面上就成了
        // 一份不知道什么时候拉的数
        tx.execute(
            "INSERT INTO settings(key,value) VALUES('fx.rates',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [Value::Object(map).to_string()],
        )?;
        tx.execute(
            "INSERT INTO settings(key,value) VALUES('fx.fetched_at',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&stamp],
        )?;
        tx.commit()?;
    }
    let c = conn.lock().unwrap();
    Ok(state(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)", []).unwrap();
        c
    }
    fn put(c: &Connection, k: &str, v: &str) {
        c.execute("INSERT OR REPLACE INTO settings VALUES(?1,?2)", [k, v]).unwrap();
    }

    #[test]
    fn the_builtin_table_is_usable_on_its_own() {
        // 离线部署全靠这张表：USD 必须在里面且恒为 1，否则一切折算都是错的
        assert_eq!(baseline().get("USD"), Some(&1.0));
        assert!(BASELINE.windows(2).all(|w| w[0].0 < w[1].0), "内置表要按币种码排好序");
        assert!(BASELINE.iter().all(|(_, v)| *v > 0.0), "内置表不能有非正的报价");
    }

    #[test]
    fn live_rates_are_layered_over_the_builtin_table() {
        let c = conn();
        // 没拉过实时汇率时，生效的就是内置表，live 是空的
        let r = rates(&c);
        assert_eq!(r.live, Vec::<String>::new());
        assert_eq!(r.map.get("CNY"), baseline().get("CNY"));

        put(&c, "fx.rates", r#"{"cny": 7.5, "TWD": 31.2}"#);
        let r = rates(&c);
        assert_eq!(r.map.get("CNY"), Some(&7.5), "实时值要盖过内置值，且币种码大小写不敏感");
        assert_eq!(r.map.get("TWD"), Some(&31.2), "内置表没有的币种也要收下");
        assert_eq!(r.map.get("EUR"), baseline().get("EUR"), "没拉到的币种回落内置值");
        assert_eq!(r.live, vec!["CNY".to_string(), "TWD".to_string()]);
    }

    #[test]
    fn junk_in_the_stored_rates_cannot_poison_the_table() {
        let c = conn();
        // 非正数与写不成样子的值一律忽略——0 会把折算除成 inf，负数会渲染出负金额
        put(&c, "fx.rates", r#"{"CNY": 0, "EUR": -1, "JPY": "很多", "HKD": 7.9}"#);
        let r = rates(&c);
        assert_eq!(r.map.get("CNY"), baseline().get("CNY"));
        assert_eq!(r.map.get("EUR"), baseline().get("EUR"));
        assert_eq!(r.map.get("JPY"), baseline().get("JPY"));
        assert_eq!(r.map.get("HKD"), Some(&7.9));
        assert_eq!(r.live, vec!["HKD".to_string()]);

        put(&c, "fx.rates", "这不是 JSON");
        assert_eq!(rates(&c).map, baseline(), "整份存坏了就当没有，别把表清空");
    }

    #[test]
    fn display_currency_is_normalised_and_empty_means_no_conversion() {
        let c = conn();
        assert_eq!(display_currency(&c), "");
        put(&c, "fx.display", " cny ");
        assert_eq!(display_currency(&c), "CNY");
    }
}
