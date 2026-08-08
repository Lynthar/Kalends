//! 库（collections）与条目（items）：一份通用 CRUD 取代原先订阅 / SIM / VPS 三份同构实现。
//! 引擎要用的字段是 items 的真列，域字段挂在 extra JSON 里（键即字段键），与自定义列同一机制。

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::api::{bad, extra_json, extra_str, f, i, missing, s, safe_name, ApiError, R};
use crate::{engine, App};

const ANCHORS: &[&str] = &["next", "last"];

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/collections", get(list).post(create))
        .route("/api/collections/templates", get(templates))
        .route("/api/collections/order", put(set_order))
        .route("/api/collections/{id}", put(update).delete(remove))
        .route("/api/collections/{key}/items", get(items_list).post(items_create))
        .route("/api/collections/{key}/items/order", put(items_order))
        .route("/api/items/bulk_delete", post(items_bulk_delete))
        .route("/api/items/{id}", put(items_update).delete(items_delete))
        .route("/api/items/{id}/renew", post(items_renew))
        .route("/api/items/{id}/logo", post(logo_set).delete(logo_clear))
        .route("/logos/{name}", get(logo_file))
}

/* ── 库 ─────────────────────────────────────────────────────────── */

const COLL_COLS: &str = "id,key,name,icon,due_anchor,subtitle,subline,verb,note_field,pos,builtin";

fn coll_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "key": r.get::<_, String>(1)?,
        "name": r.get::<_, String>(2)?,
        "icon": r.get::<_, Option<String>>(3)?,
        "due_anchor": r.get::<_, String>(4)?,
        "subtitle": r.get::<_, Option<String>>(5)?,
        "subline": r.get::<_, Option<String>>(6)?,
        "verb": r.get::<_, Option<String>>(7)?,
        "note_field": r.get::<_, Option<String>>(8)?,
        "pos": r.get::<_, i64>(9)?,
        "builtin": r.get::<_, i64>(10)? != 0,
    }))
}

pub fn collections(conn: &Connection) -> anyhow::Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLL_COLS} FROM collections ORDER BY pos, id"
    ))?;
    let rows: Vec<Value> = stmt.query_map([], coll_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

async fn list(State(app): State<App>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!(collections(&conn)?)))
}

/// 库 id：按 key 找。找不到就是 404 级错误，交给调用方兜。
fn coll_id(conn: &Connection, key: &str) -> anyhow::Result<i64> {
    conn.query_row("SELECT id FROM collections WHERE key=?1", [key], |r| r.get(0))
        .map_err(|_| missing(format!("库不存在：{key}")))
}

fn anchor_of(conn: &Connection, id: i64) -> anyhow::Result<String> {
    Ok(conn.query_row(
        "SELECT due_anchor FROM collections WHERE id=?1",
        [id],
        |r| r.get(0),
    )?)
}

/// 新库的键：k<历史用过的最大编号 + 1>。
///
/// 不能拿 rowid 派生。SQLite 不带 AUTOINCREMENT 时会复用删掉的 id，而删库按设计保留
/// 台账与通知日志（那两张表存的是 kind 字符串，不跟着外键走），于是新库会捡到旧库的
/// kind：台账里凭空多出别人的付款记录，通知去重键也可能把新条目判成"已发过"而漏发。
/// 所以编号要越过所有"曾经用过"的痕迹，而不只是现存的库。
fn next_coll_key(conn: &Connection) -> rusqlite::Result<String> {
    let n: i64 = conn.query_row(
        "SELECT coalesce(max(n),0)+1 FROM (
           SELECT CAST(substr(key, 2) AS INTEGER) n FROM collections       WHERE key  GLOB 'k[0-9]*'
           UNION ALL
           SELECT CAST(substr(kind,2) AS INTEGER)  FROM renewal_ledger     WHERE kind GLOB 'k[0-9]*'
           UNION ALL
           SELECT CAST(substr(kind,2) AS INTEGER)  FROM notification_log   WHERE kind GLOB 'k[0-9]*')",
        [],
        |r| r.get(0),
    )?;
    Ok(format!("k{n}"))
}

async fn create(State(app): State<App>, Json(b): Json<Value>) -> R {
    let tpl = match s(&b, "template") {
        Some(id) => Some(template(&id).ok_or_else(|| bad(format!("未知模板：{id}")))?),
        None => None,
    };
    let name = s(&b, "name").ok_or_else(|| bad("库名不能为空"))?;
    let anchor = s(&b, "due_anchor")
        .or_else(|| tpl.map(|t| t.anchor.to_string()))
        .unwrap_or_else(|| "last".into());
    if !ANCHORS.contains(&anchor.as_str()) {
        return Err(bad(format!("未知的到期模型：{anchor}")).into());
    }
    let opt = |x: &'static str| (!x.is_empty()).then(|| x.to_string());
    // 模板只在调用方压根没提这个键时兜底：界面清空图标传的是 ""，不该被模板值顶回来
    let take = |k: &str, dflt: Option<String>| -> Option<String> {
        if b.get(k).is_some() { s(&b, k) } else { dflt }
    };
    let conn = app.db.lock().unwrap();
    let pos: i64 = conn.query_row("SELECT coalesce(max(pos),0)+1 FROM collections", [], |r| {
        r.get(0)
    })?;
    // 键自己生成，不让用户起名——免得撞上内置键或者带进路径字符
    let key = next_coll_key(&conn)?;
    // 建库与播字段集要么一起成、要么一条都不落：半途断在中间留下的是一个没有任何列的
    // 空壳库，界面上是张点不动的空表
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO collections(key,name,icon,due_anchor,subtitle,subline,verb,note_field,pos,builtin)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0)",
        params![
            key,
            name,
            take("icon", tpl.and_then(|t| opt(t.icon))),
            anchor,
            tpl.and_then(|t| opt(t.subtitle)),
            tpl.and_then(|t| opt(t.subline)),
            take("verb", tpl.and_then(|t| opt(t.verb))),
            tpl.and_then(|t| opt(t.note_field)),
            pos
        ],
    )?;
    let id = tx.last_insert_rowid();
    seed_fields(&tx, &key, &anchor, tpl)?;
    let row = tx.query_row(
        &format!("SELECT {COLL_COLS} FROM collections WHERE id=?1"),
        [id],
        coll_row,
    )?;
    tx.commit()?;
    Ok(Json(row))
}

/* ── 建库模板：一套预置字段集 + 库属性，免得新建的库是个空壳 ────────── */

/// 模板只决定"库刚建好时长什么样"，落表后就是普通字段——域字段与用户手加的
/// 自定义列同权（`builtin=0`），可改名、可改选项、可删。
/// 模板的一个域字段。默认值见 `EXTRA`，写模板时只列与默认不同的键。
struct Field {
    key: &'static str,
    name: &'static str,
    ftype: &'static str,
    /// `extra` 值挂 items.extra JSON；`calc` 只读、由模板串或服务端算出
    src: &'static str,
    shown: i64,
    /// 预置选项，逗号分隔。只给真正封闭的词表，开放词表留空让它从数据里长
    options: &'static str,
    /// 类型专属配置，目前只有 tpl 类型用它的 `{"tpl":"..."}`；空=无
    config: &'static str,
}

/// 域字段的默认形态：值进 extra、只进详情表单、无预置选项。
const EXTRA: Field = Field {
    key: "",
    name: "",
    ftype: "text",
    src: "extra",
    shown: 0,
    options: "",
    config: "",
};

struct Template {
    id: &'static str,
    label: &'static str,
    icon: &'static str,
    desc: &'static str,
    anchor: &'static str,
    verb: &'static str,
    /// 名称格下方小字取哪个字段（不进日历标题，那是 subtitle）
    subline: &'static str,
    /// 拼进到期时间线与日历标题的字段（VPS 的「商家 · 产品」）
    subtitle: &'static str,
    /// 进日历事件描述的 extra 键
    note_field: &'static str,
    /// 状态词表；空=用通用的 `STATUS_VOCAB`
    status: &'static str,
    /// 对通用字段的调整：(字段键, 显示名；空=沿用默认, 是否默认上表)
    base: &'static [(&'static str, &'static str, i64)],
    /// 域字段。落表后一律 builtin=0，与用户手加的自定义列同权
    extra: &'static [Field],
}

/// 模板的默认形态：无到期动作说法、无副标题、通用状态词表、只有通用字段。
/// 写模板时只列与默认不同的键——`verb` 留空时前后端都回落成「续费」。
const TPL: Template = Template {
    id: "",
    label: "",
    icon: "",
    desc: "",
    anchor: "last",
    verb: "",
    subline: "",
    subtitle: "",
    note_field: "",
    status: "",
    base: &[],
    extra: &[],
};

/// 第一项必须是空白模板：前端的模板选择器默认选它。
/// 预置选项只给真正封闭的词表；注册商、保险公司这类开放词表留空，让它从数据里长出来。
const TEMPLATES: &[Template] = &[
    Template {
        id: "blank",
        label: "空白",
        desc: "只有通用字段，列自己加",
        ..TPL
    },
    // 订阅 / SIM / VPS 三个预置库也在这里：它们此前只由迁移 0007/0008 一次性建出来，
    // 删掉就再也建不回来，也没法建第二个同类库。字段集与 0008 对齐，由单测钉住不漂移。
    Template {
        id: "subs",
        label: "订阅",
        icon: "🔁",
        desc: "会员与服务的周期续费",
        anchor: "next",
        status: RENEWAL_STATUS_VOCAB,
        base: &[("price", "价格", 1), ("next_renewal", "下次续费", 1)],
        extra: &[
            Field {
                key: "category",
                name: "分类",
                ftype: "sel",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "payment_method",
                name: "支付方式",
                ftype: "sel",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "account",
                name: "账号",
                ..EXTRA
            },
        ],
        ..TPL
    },
    Template {
        id: "sims",
        label: "SIM 卡",
        icon: "📱",
        desc: "号码保号与到期",
        verb: "保号",
        status: RENEWAL_STATUS_VOCAB,
        subline: "phone_number",
        note_field: "keepalive_action",
        // 保号周期恒为自定义天数，所以费用/周期/链接退进详情表单，不占表格列位。
        // 预置库 sims 干脆没注册 cycle 列，那正是「SIM 每次编辑都清掉周期」的成因——
        // 这里注册上（只是不上表），同类缺陷从根上不会再有。
        base: &[
            ("price", "", 0),
            ("cycle", "", 0),
            ("notes", "", 0),
            ("url", "", 0),
        ],
        extra: &[
            Field {
                key: "forms",
                name: "形式",
                ftype: "multi",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "keepalive_action",
                name: "保号动作",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "phone_number",
                name: "号码",
                ..EXTRA
            },
        ],
        ..TPL
    },
    Template {
        id: "vps",
        label: "VPS / 云实例",
        icon: "☁️",
        desc: "云主机的续费与规格",
        status: RENEWAL_STATUS_VOCAB,
        subline: "product",
        // 商家是条目名，产品名拼进到期时间线与日历标题
        subtitle: "product",
        base: &[("name", "商家", 1), ("cycle", "", 0), ("notes", "", 0)],
        extra: &[
            Field {
                key: "locations",
                name: "地点",
                ftype: "multi",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "purpose",
                name: "用途",
                ftype: "sel",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "spec",
                name: "规格",
                ftype: "tpl",
                src: "calc",
                shown: 1,
                config: r#"{"tpl":"{cores}C / {ram_gb}G / {storage_gb}G {storage_type}"}"#,
                ..EXTRA
            },
            Field {
                key: "routes",
                name: "线路",
                ftype: "multi",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "product",
                name: "产品",
                ..EXTRA
            },
            Field {
                key: "cores",
                name: "核心",
                ftype: "num",
                ..EXTRA
            },
            Field {
                key: "ram_gb",
                name: "内存 GB",
                ftype: "num",
                ..EXTRA
            },
            Field {
                key: "storage_gb",
                name: "存储 GB",
                ftype: "num",
                ..EXTRA
            },
            Field {
                key: "storage_type",
                name: "存储类型",
                ftype: "sel",
                ..EXTRA
            },
            Field {
                key: "extra_storage",
                name: "附加存储",
                ..EXTRA
            },
            Field {
                key: "port_gbps",
                name: "端口 Gbps",
                ftype: "num",
                ..EXTRA
            },
            Field {
                key: "traffic_tb",
                name: "流量 TB",
                ftype: "num",
                ..EXTRA
            },
            Field {
                key: "ipv6",
                name: "IPv6",
                ftype: "num",
                ..EXTRA
            },
            Field {
                key: "account",
                name: "账号",
                ..EXTRA
            },
        ],
        ..TPL
    },
    Template {
        id: "domain",
        label: "域名",
        icon: "🌐",
        desc: "域名注册与到期",
        anchor: "next",
        verb: "续费",
        base: &[("next_renewal", "到期日", 1)],
        extra: &[
            Field {
                key: "registrar",
                name: "注册商",
                ftype: "sel",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "auto_renew",
                name: "自动续费",
                ftype: "sel",
                shown: 1,
                options: "开,关",
                ..EXTRA
            },
            Field {
                key: "dns",
                name: "DNS 托管",
                ftype: "sel",
                ..EXTRA
            },
            Field {
                key: "usage",
                name: "用途",
                ftype: "sel",
                ..EXTRA
            },
        ],
        ..TPL
    },
    Template {
        id: "insurance",
        label: "保险",
        icon: "🛡️",
        desc: "保单与续保日",
        anchor: "next",
        verb: "续保",
        subline: "policy_no",
        base: &[("next_renewal", "保单到期", 1)],
        extra: &[
            Field {
                key: "insurer",
                name: "保险公司",
                ftype: "sel",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "policy_type",
                name: "险种",
                ftype: "sel",
                shown: 1,
                options: "医疗,重疾,意外,寿险,车险,财产,旅行",
                ..EXTRA
            },
            Field {
                key: "insured",
                name: "被保险人",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "coverage",
                name: "保额",
                ftype: "num",
                ..EXTRA
            },
            Field {
                key: "policy_no",
                name: "保单号",
                ..EXTRA
            },
        ],
        ..TPL
    },
    Template {
        id: "docs",
        label: "证件",
        icon: "🪪",
        desc: "护照签证等有效期",
        anchor: "next",
        verb: "换证",
        // 证件多半没有周期费用：费用与周期退进详情表单，不占表格列位
        base: &[
            ("next_renewal", "有效期至", 1),
            ("price", "工本费", 0),
            ("cycle", "", 0),
        ],
        extra: &[
            Field {
                key: "doc_type",
                name: "证件类型",
                ftype: "sel",
                shown: 1,
                options: "护照,身份证,驾照,签证,居留许可,通行证",
                ..EXTRA
            },
            Field {
                key: "holder",
                name: "持有人",
                shown: 1,
                ..EXTRA
            },
            Field {
                key: "doc_no",
                name: "证件号码",
                ..EXTRA
            },
            Field {
                key: "issuer",
                name: "签发机关",
                ..EXTRA
            },
        ],
        ..TPL
    },
];

fn template(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
}

async fn templates() -> R {
    let out: Vec<Value> = TEMPLATES
        .iter()
        .map(|t| {
            json!({
                "id": t.id,
                "label": t.label,
                "icon": t.icon,
                "desc": t.desc,
                "due_anchor": t.anchor,
                "verb": t.verb,
                // 域字段的显示名，供选择器预览；含只进详情表单（shown=0）的那些
                "fields": t.extra.iter().map(|f| f.name).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

/// 新建的库要能直接用：播一套默认字段集，否则表格没有列、详情表单是空的。
/// 到期锚点决定给"下次到期日"还是"上次续费 + 剩余天数"，模板再往上加域字段。
/// 词表按 SQLite `json()` 的形态写成紧凑一行：迁移 0008 播状态词表时用的就是它，
/// 两边要逐字节一致，模板等价单测才对得上（serde_json 会按字母重排键，不能拿来压缩）。
const STATUS_VOCAB: &str = r#"[{"v":"Active","spend":1,"alert":1,"timeline":1},{"v":"Planned","spend":0,"alert":0,"timeline":0},{"v":"Ending","spend":0,"alert":0,"timeline":1},{"v":"Ended","spend":0,"alert":0,"timeline":0}]"#;

/// 三个续费库共用的六值词表：比通用词表多 Deferred（比价目录，记各档位供比较）
/// 与 Unused（未启用），两者都不计支出、不提醒、不上时间线。
const RENEWAL_STATUS_VOCAB: &str = r#"[{"v":"Active","spend":1,"alert":1,"timeline":1},{"v":"Planned","spend":0,"alert":0,"timeline":0},{"v":"Deferred","spend":0,"alert":0,"timeline":0},{"v":"Unused","spend":0,"alert":0,"timeline":0},{"v":"Ending","spend":0,"alert":0,"timeline":1},{"v":"Ended","spend":0,"alert":0,"timeline":0}]"#;

fn seed_fields(
    conn: &Connection,
    key: &str,
    anchor: &str,
    tpl: Option<&Template>,
) -> anyhow::Result<()> {
    // (键, 显示名, 类型, 数据源, 默认上表, 序)；序号留了空档，模板的域字段插在 10 段
    let mut defs: Vec<(&str, &str, &str, &str, i64, i64)> = vec![
        ("name", "名称", "text", "col", 1, 1),
        ("status", "状态", "status", "col", 1, 2),
        // 币种不再是自己一列：它并进费用格里，跟着金额一起填（见 fx.rs / 迁移 0013）
        ("price", "费用", "num", "col", 1, 30),
        ("cycle", "周期", "sel", "col", 1, 32),
    ];
    if anchor == "next" {
        defs.push(("next_renewal", "下次到期", "date", "col", 1, 40));
    } else {
        defs.push(("last_renewed", "上次续费", "date", "col", 1, 40));
        defs.push(("left", "剩余天数", "num", "calc", 1, 41));
    }
    defs.push(("notes", "备注", "text", "col", 1, 50));
    defs.push(("cycle_days", "周期天数", "num", "col", 0, 60));
    defs.push(("url", "链接", "text", "col", 0, 61));
    for (k, name, shown) in tpl.map_or(&[][..], |t| t.base) {
        let Some(d) = defs.iter_mut().find(|d| d.0 == *k) else {
            continue;
        };
        if !name.is_empty() {
            d.1 = name;
        }
        d.4 = *shown;
    }
    for (k, name, ftype, src, shown, pos) in defs {
        let status_vocab = match tpl.map(|t| t.status) {
            Some(v) if !v.is_empty() => v,
            _ => STATUS_VOCAB,
        };
        let options = if k == "status" { status_vocab } else { "[]" };
        conn.execute(
            "INSERT INTO fields(tbl,key,name,ftype,src,shown,pos,builtin,options)
             VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8)
             ON CONFLICT(tbl,key) DO NOTHING",
            params![key, k, name, ftype, src, shown, pos, options],
        )?;
    }
    for (n, f) in tpl.map_or(&[][..], |t| t.extra).iter().enumerate() {
        let options = serde_json::to_string(
            &f.options
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| json!({ "v": v }))
                .collect::<Vec<_>>(),
        )?;
        conn.execute(
            "INSERT INTO fields(tbl,key,name,ftype,src,shown,pos,builtin,options,config)
             VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,?9)
             ON CONFLICT(tbl,key) DO NOTHING",
            params![
                key,
                f.key,
                f.name,
                f.ftype,
                f.src,
                f.shown,
                10 + n as i64,
                options,
                (!f.config.is_empty()).then_some(f.config)
            ],
        )?;
    }
    Ok(())
}

async fn update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let cur = conn
        .query_row(
            &format!("SELECT {COLL_COLS} FROM collections WHERE id=?1"),
            [id],
            coll_row,
        )
        .map_err(|_| missing("库不存在"))?;
    // 逐字段合并：只改传来的键，其余保留
    let pick = |k: &str| -> Option<String> { s(&b, k) };
    let anchor = pick("due_anchor").unwrap_or_else(|| cur["due_anchor"].as_str().unwrap().into());
    if !ANCHORS.contains(&anchor.as_str()) {
        return Err(bad(format!("未知的到期模型：{anchor}")).into());
    }
    let name = pick("name").unwrap_or_else(|| cur["name"].as_str().unwrap().into());
    if name.is_empty() {
        return Err(bad("库名不能为空").into());
    }
    let take = |k: &str| -> Option<String> {
        if b.get(k).is_some() {
            pick(k)
        } else {
            cur[k].as_str().map(String::from)
        }
    };
    let pos = i(&b, "pos").unwrap_or_else(|| cur["pos"].as_i64().unwrap());
    conn.execute(
        "UPDATE collections SET name=?1,icon=?2,due_anchor=?3,subtitle=?4,subline=?5,
         verb=?6,note_field=?7,pos=?8 WHERE id=?9",
        params![
            name,
            take("icon"),
            anchor,
            take("subtitle"),
            take("subline"),
            take("verb"),
            take("note_field"),
            pos,
            id
        ],
    )?;
    Ok(Json(json!({ "ok": true })))
}

// 库顺序：整份 id 序落成 pos，决定标签行的排列。
// 路由排在 `/api/collections/{id}` 之前——静态段优先于路径参数，"order" 不会被当成 id。
async fn set_order(State(app): State<App>, Json(b): Json<Value>) -> R {
    let ids: Vec<i64> = b
        .get("ids")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(bad("缺少 ids").into());
    }
    let conn = app.db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    for (n, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE collections SET pos=?1 WHERE id=?2",
            params![n as i64 + 1, id],
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    let key: String = conn
        .query_row("SELECT key FROM collections WHERE id=?1", [id], |r| r.get(0))
        .map_err(|_| missing("库不存在"))?;
    // 条目随库走（外键 ON DELETE CASCADE），先把 logo 文件清掉免得留孤儿
    let mut stmt = conn.prepare("SELECT logo FROM items WHERE collection_id=?1 AND logo IS NOT NULL")?;
    let logos: Vec<String> = stmt
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    // 库与它的字段注册表一起消失：只删掉一半的话，剩下的那半是一批够不着的孤儿列记录
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM collections WHERE id=?1", [id])?;
    tx.execute("DELETE FROM fields WHERE tbl=?1", [&key])?;
    tx.commit()?;
    for name in logos {
        remove_logo_file(&app2, Some(name));
    }
    Ok(Json(json!({ "ok": true })))
}

/* ── 条目 ───────────────────────────────────────────────────────── */

// pos 排在最后：它不在 WRITE_COLS 里（手动序只由 /items/order 改，整行 PUT 碰不到它），
// 追加在末尾就不必动 item_row 里既有的下标。
const ITEM_COLS: &str = "id,collection_id,name,parent_id,status,price,currency,cycle,cycle_days,\
                         next_renewal,last_renewed,url,notes,logo,extra,created_at,updated_at,pos";

pub fn item_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "collection_id": r.get::<_, i64>(1)?,
        "name": r.get::<_, String>(2)?,
        "parent_id": r.get::<_, Option<i64>>(3)?,
        "status": r.get::<_, String>(4)?,
        "price": r.get::<_, Option<f64>>(5)?,
        "currency": r.get::<_, Option<String>>(6)?,
        "cycle": r.get::<_, Option<String>>(7)?,
        "cycle_days": r.get::<_, Option<i64>>(8)?,
        "next_renewal": r.get::<_, Option<String>>(9)?,
        "last_renewed": r.get::<_, Option<String>>(10)?,
        "url": r.get::<_, Option<String>>(11)?,
        "notes": r.get::<_, Option<String>>(12)?,
        "logo": r.get::<_, Option<String>>(13)?,
        "extra": extra_json(r.get::<_, Option<String>>(14)?),
        "created_at": r.get::<_, String>(15)?,
        "updated_at": r.get::<_, String>(16)?,
        "pos": r.get::<_, Option<i64>>(17)?,
    }))
}

/// 一个库里的条目；带上按库到期模型算出的到期日与剩余天数。
pub fn items_of(conn: &Connection, key: &str) -> anyhow::Result<Vec<Value>> {
    let id = coll_id(conn, key)?;
    let anchor = anchor_of(conn, id)?;
    // pos 为空的排在最后（迁移之前建的行不会有，理论上不该出现，出现了也别把它们藏起来）
    let mut stmt = conn.prepare(&format!(
        "SELECT {ITEM_COLS} FROM items WHERE collection_id=?1 ORDER BY pos IS NULL, pos, id"
    ))?;
    let mut rows: Vec<Value> = stmt
        .query_map([id], item_row)?
        .collect::<rusqlite::Result<_>>()?;
    let today = engine::today();
    for r in rows.iter_mut() {
        let due = due_of(r, &anchor);
        r["due"] = json!(due.map(|d| d.to_string()));
        r["days_left"] = json!(due.map(|d| (d - today).num_days()));
    }
    Ok(rows)
}

/// 到期日：due_anchor='next' 直接读下次续费日，否则从上次续费按周期推一步。
pub fn due_of(r: &Value, anchor: &str) -> Option<NaiveDate> {
    let cycle = r["cycle"].as_str().unwrap_or("");
    if cycle == "lifetime" {
        return None;
    }
    if anchor == "next" {
        return NaiveDate::parse_from_str(r["next_renewal"].as_str()?, "%Y-%m-%d").ok();
    }
    let last = NaiveDate::parse_from_str(r["last_renewed"].as_str()?, "%Y-%m-%d").ok()?;
    engine::advance(last, cycle, r["cycle_days"].as_i64())
}

async fn items_list(State(app): State<App>, Path(key): Path<String>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!(items_of(&conn, &key)?)))
}

/// 写入用的字段集：整行 PUT 语义是全量替换，没传的键一律置空。
fn item_values(b: &Value) -> anyhow::Result<Vec<rusqlite::types::Value>> {
    use rusqlite::types::Value as V;
    // 空名是允许的：表尾「＋ 新建」直接插一行空行、就地填（Notion 同款），拦下它这条路就没了。
    // 界面上空名渲染成灰色「未命名」占位，通知与 ICS 同样兜底，不会输出空标题。
    let name = s(b, "name").unwrap_or_default();
    Ok(vec![
        V::from(name),
        i(b, "parent_id").map(V::from).unwrap_or(V::Null),
        V::from(s(b, "status").unwrap_or_else(|| "Planned".into())),
        f(b, "price").map(V::from).unwrap_or(V::Null),
        s(b, "currency").map(V::from).unwrap_or(V::Null),
        s(b, "cycle").map(V::from).unwrap_or(V::Null),
        i(b, "cycle_days").map(V::from).unwrap_or(V::Null),
        s(b, "next_renewal").map(V::from).unwrap_or(V::Null),
        s(b, "last_renewed").map(V::from).unwrap_or(V::Null),
        s(b, "url").map(V::from).unwrap_or(V::Null),
        s(b, "notes").map(V::from).unwrap_or(V::Null),
        s(b, "logo").map(V::from).unwrap_or(V::Null),
        extra_str(b).map(V::from).unwrap_or(V::Null),
    ])
}

const WRITE_COLS: &str = "name,parent_id,status,price,currency,cycle,cycle_days,\
                          next_renewal,last_renewed,url,notes,logo,extra";

/// 子行只有两层（服务 → 档位）：父行自己不能再有父行，本条目已有子行时也不能再挂到别人下面。
/// 表格的渲染只下探一层，三层的孙行会既不在顶层也不被渲染——静默从界面消失，所以在写入口拦住。
fn check_parent(conn: &Connection, coll: i64, id: Option<i64>, parent: Option<i64>) -> anyhow::Result<()> {
    let Some(p) = parent else { return Ok(()) };
    if Some(p) == id {
        return Err(bad("条目不能是自己的父行"));
    }
    let (pcoll, pparent): (i64, Option<i64>) = conn
        .query_row(
            "SELECT collection_id,parent_id FROM items WHERE id=?1",
            [p],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| missing("父行不存在"))?;
    if pcoll != coll {
        return Err(bad("父行必须与本条目在同一个库"));
    }
    if pparent.is_some() {
        return Err(bad("子行只支持两层：所选父行本身已经是子行"));
    }
    if let Some(id) = id {
        let kids: i64 =
            conn.query_row("SELECT count(*) FROM items WHERE parent_id=?1", [id], |r| r.get(0))?;
        if kids > 0 {
            return Err(bad("子行只支持两层：本条目已有子行，不能再挂到别的行下"));
        }
    }
    Ok(())
}

pub fn insert_item(conn: &Connection, coll: i64, b: &Value) -> anyhow::Result<i64> {
    check_parent(conn, coll, None, i(b, "parent_id"))?;
    let mut vals = item_values(b)?;
    vals.insert(0, rusqlite::types::Value::from(coll));
    // 新行落在手动序末尾。pos 不在 WRITE_COLS 里，只在这里和 /items/order 两处写。
    let pos: i64 = conn.query_row(
        "SELECT COALESCE(MAX(pos),0)+1 FROM items WHERE collection_id=?1",
        [coll],
        |r| r.get(0),
    )?;
    vals.push(rusqlite::types::Value::from(pos));
    conn.execute(
        &format!(
            "INSERT INTO items(collection_id,{WRITE_COLS},pos) VALUES({})",
            (1..=vals.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(",")
        ),
        rusqlite::params_from_iter(vals),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_item(conn: &Connection, id: i64, b: &Value) -> anyhow::Result<()> {
    let coll: i64 = conn
        .query_row("SELECT collection_id FROM items WHERE id=?1", [id], |r| r.get(0))
        .map_err(|_| missing("条目不存在"))?;
    check_parent(conn, coll, Some(id), i(b, "parent_id"))?;
    let mut vals = item_values(b)?;
    let sets = WRITE_COLS
        .split(',')
        .enumerate()
        .map(|(n, c)| format!("{}=?{}", c.trim(), n + 1))
        .collect::<Vec<_>>()
        .join(",");
    vals.push(rusqlite::types::Value::from(id));
    let n = conn.execute(
        &format!(
            "UPDATE items SET {sets},updated_at=datetime('now') WHERE id=?{}",
            vals.len()
        ),
        rusqlite::params_from_iter(vals),
    )?;
    if n == 0 {
        return Err(missing("条目不存在"));
    }
    Ok(())
}

async fn items_create(State(app): State<App>, Path(key): Path<String>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    let coll = coll_id(&conn, &key)?;
    let id = insert_item(&conn, coll, &b)?;
    Ok(Json(json!({ "id": id })))
}

async fn items_update(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    update_item(&conn, id, &b)?;
    Ok(Json(json!({ "ok": true })))
}

pub fn delete_item(app: &App, conn: &Connection, id: i64) -> anyhow::Result<()> {
    let logo: Option<String> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .unwrap_or(None);
    conn.execute("DELETE FROM items WHERE id=?1", [id])?;
    remove_logo_file(app, logo);
    Ok(())
}

async fn items_delete(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    delete_item(&app2, &conn, id)?;
    Ok(Json(json!({ "ok": true })))
}

/// 批量端点的 ids 数组（库与媒体共用）。
pub fn id_list(b: &Value) -> anyhow::Result<Vec<i64>> {
    let ids: Vec<i64> = b
        .get("ids")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(bad("缺少 ids"));
    }
    Ok(ids)
}

/// 整份手动序：收到的是这个库当前的完整行序，按下标落 pos。
/// 只改属于该库的行——越库的 id 静默跳过，免得这个端点变成"替我改任意条目的 pos"。
async fn items_order(State(app): State<App>, Path(key): Path<String>, Json(b): Json<Value>) -> R {
    let ids = id_list(&b)?;
    let conn = app.db.lock().unwrap();
    let coll = coll_id(&conn, &key)?;
    let tx = conn.unchecked_transaction()?;
    for (n, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE items SET pos=?1 WHERE id=?2 AND collection_id=?3",
            params![n as i64 + 1, id, coll],
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

/// 批量删除。整批在一个事务里，要么全删要么一条不删——半途失败留下"删了一半"的选区，
/// 用户看到的是删除按钮报错却又少了几行。图标文件在提交之后才清，回滚了就不会留孤儿。
async fn items_bulk_delete(State(app): State<App>, Json(b): Json<Value>) -> R {
    let ids = id_list(&b)?;
    let conn = app.db.lock().unwrap();
    let mut logos = Vec::new();
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        let logo: Option<String> = tx
            .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
            .unwrap_or(None);
        logos.push(logo);
        tx.execute("DELETE FROM items WHERE id=?1", [id])?;
    }
    tx.commit()?;
    for logo in logos {
        remove_logo_file(&app, logo);
    }
    Ok(Json(json!({ "ok": true, "deleted": ids.len() })))
}

/// 记一笔续费：写台账并按库的到期模型推进日期。
/// anchor='next' 推进 next_renewal（逾期则连推到今天之后），anchor='last' 把上次续费记为今天。
pub fn renew_item(conn: &Connection, id: i64, b: &Value) -> anyhow::Result<Value> {
    let row: Option<(String, String, Option<f64>, Option<String>, Option<String>, Option<i64>, Option<String>)> =
        conn.query_row(
            "SELECT c.key, c.due_anchor, i.price, i.currency, i.cycle, i.cycle_days, i.next_renewal
             FROM items i JOIN collections c ON c.id=i.collection_id WHERE i.id=?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .ok();
    let Some((key, anchor, price, currency, cycle, cycle_days, next)) = row else {
        return Err(missing("条目不存在"));
    };
    let today = engine::today();
    // 记账与推日期是一件事：只落成一半的话，账记了而到期日没动，界面照旧显示逾期，
    // 而台账已经声称这笔付过了——"台账=事实"这条承诺就断在这里
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO renewal_ledger(kind,item_id,renewed_at,amount,currency,note)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            key,
            id,
            today.to_string(),
            f(b, "amount").or(price),
            s(b, "currency").or(currency),
            s(b, "note"),
        ],
    )?;
    let out = if anchor == "next" {
        let mut new_next: Option<String> = None;
        if let (Some(cy), Some(nx)) = (cycle.as_deref(), next.as_deref()) {
            if let Ok(start) = NaiveDate::parse_from_str(nx, "%Y-%m-%d") {
                if let Some(mut d) = engine::advance(start, cy, cycle_days) {
                    while d <= today {
                        match engine::advance(d, cy, cycle_days) {
                            Some(n) => d = n,
                            None => break,
                        }
                    }
                    new_next = Some(d.to_string());
                }
            }
        }
        if let Some(n) = &new_next {
            tx.execute(
                "UPDATE items SET next_renewal=?1,updated_at=datetime('now') WHERE id=?2",
                params![n, id],
            )?;
        }
        json!({ "next_renewal": new_next })
    } else {
        tx.execute(
            "UPDATE items SET last_renewed=?1,updated_at=datetime('now') WHERE id=?2",
            params![today.to_string(), id],
        )?;
        json!({ "last_renewed": today.to_string() })
    };
    tx.commit()?;
    Ok(out)
}

async fn items_renew(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(renew_item(&conn, id, &b)?))
}

/* ── 条目图标：原始字节上传（?ext= 定格式），文件存数据目录 logos/，列存文件名 ── */

// 上传字节的魔数须与声明格式一致，防止把可执行内容伪装成图片存进来
fn logo_bytes_ok(ext: &str, b: &[u8]) -> bool {
    match ext {
        "png" => b.starts_with(b"\x89PNG"),
        "jpg" | "jpeg" => b.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => b.starts_with(b"GIF8"),
        "webp" => b.len() > 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP",
        "ico" => b.starts_with(&[0x00, 0x00, 0x01, 0x00]),
        "svg" => {
            let head = String::from_utf8_lossy(&b[..b.len().min(256)]).to_lowercase();
            let head = head.trim_start_matches('\u{feff}').trim_start();
            head.starts_with("<svg") || head.starts_with("<?xml")
        }
        _ => false,
    }
}

pub fn remove_logo_file(app: &App, name: Option<String>) {
    if let Some(n) = name.filter(|n| safe_name(n)) {
        let _ = std::fs::remove_file(app.data_dir.join("logos").join(n));
    }
}

pub fn set_logo(
    app: &App,
    conn: &Connection,
    id: i64,
    ext: &str,
    body: &[u8],
) -> anyhow::Result<String> {
    if !matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "svg" | "gif" | "ico") {
        return Err(bad("不支持的图片格式"));
    }
    if body.is_empty() || body.len() > 1_000_000 {
        return Err(bad("图片为空或超过 1MB"));
    }
    if !logo_bytes_ok(ext, body) {
        return Err(bad("图片内容与声明格式不符"));
    }
    let old: Option<Option<String>> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .ok();
    let Some(old) = old else {
        return Err(missing("条目不存在"));
    };
    let dir = app.data_dir.join("logos");
    std::fs::create_dir_all(&dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let name = format!("item-{id}-{stamp}.{ext}");
    std::fs::write(dir.join(&name), body)?;
    conn.execute(
        "UPDATE items SET logo=?1,updated_at=datetime('now') WHERE id=?2",
        params![name, id],
    )?;
    remove_logo_file(app, old);
    Ok(name)
}

async fn logo_set(
    State(app): State<App>,
    Path(id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> R {
    let ext = q.get("ext").cloned().unwrap_or_default();
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    let name = set_logo(&app2, &conn, id, &ext, &body)?;
    Ok(Json(json!({ "logo": name })))
}

pub fn clear_logo(app: &App, conn: &Connection, id: i64) -> anyhow::Result<()> {
    let old: Option<Option<String>> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .ok();
    let Some(old) = old else {
        return Err(missing("条目不存在"));
    };
    conn.execute(
        "UPDATE items SET logo=NULL,updated_at=datetime('now') WHERE id=?1",
        [id],
    )?;
    remove_logo_file(app, old);
    Ok(())
}

async fn logo_clear(State(app): State<App>, Path(id): Path<i64>) -> R {
    let app2 = app.clone();
    let conn = app.db.lock().unwrap();
    clear_logo(&app2, &conn, id)?;
    Ok(Json(json!({ "ok": true })))
}

// 与媒体封面同款：文件名白名单 + 静态读 + 长缓存
async fn logo_file(State(app): State<App>, Path(name): Path<String>) -> Result<Response, ApiError> {
    if !safe_name(&name) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let path = app.data_dir.join("logos").join(&name);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        _ => "image/jpeg",
    };
    let mut resp = (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=604800"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response();
    if mime == "image/svg+xml" {
        // SVG 可携带脚本：<img> 引用本就不执行，这里再把直接打开的场景沙箱化
        resp.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            header::HeaderValue::from_static(
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            ),
        );
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一行字段的可比形态。**故意不含 pos**：迁移 0008 自己编了一套序号，而字段顺序本就
    /// 是用户可拖动的呈现细节（`PUT /api/fields/order` 会整份重写），钉它只会逼模板去
    /// 复刻一段没有语义的历史编号。
    type Row = (String, String, String, String, i64, i64, String, String);

    fn fields_of(conn: &Connection, tbl: &str) -> Vec<Row> {
        let mut st = conn
            .prepare(
                "SELECT key,name,ftype,src,shown,builtin,options,coalesce(config,'')
                   FROM fields WHERE tbl=?1 ORDER BY key",
            )
            .unwrap();
        st.query_map([tbl], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    /// 用模板在同一个库里播一套字段，返回它的可比形态。
    fn seeded_by_template(conn: &Connection, id: &str) -> Vec<Row> {
        let t = template(id).unwrap_or_else(|| panic!("模板 {id} 不存在"));
        let tbl = format!("tpl_{id}");
        seed_fields(conn, &tbl, t.anchor, Some(t)).unwrap();
        fields_of(conn, &tbl)
    }

    /// 订阅 / SIM / VPS 三个预置库由迁移 0007/0008 建出来，而模板里也有一份同名的描述。
    /// 副本删不掉（已发布的迁移不能改，全新安装照样会走 0008），但漂移可以变成测试失败：
    /// 这条钉的就是"模板产出 ⊇ 迁移产出，且多出来的恰好是这几个说得清的字段"。
    #[test]
    fn builtin_collections_match_their_templates() {
        let conn = crate::db::fresh_in_memory().unwrap();
        // 模板多出来的字段：只有 SIM。预置库 sims 压根没注册费用/周期/链接三列，
        // 而通用字段集恒含它们——模板把它们注册上、但不上表（base 里 shown=0）。
        // 「sims 没注册 cycle」正是"SIM 每次界面编辑都清掉周期"那个缺陷的成因，
        // 所以这里的差异是有意为之的修正，不是漂移。
        let allowed_extra: &[(&str, &[&str])] = &[
            ("subs", &[]),
            ("sims", &["cycle", "price", "url"]),
            ("vps", &[]),
        ];

        for (key, extra_keys) in allowed_extra {
            let migrated = fields_of(&conn, key);
            let templated = seeded_by_template(&conn, key);
            assert!(!migrated.is_empty(), "{key}：全新安装后该有字段");

            // 迁移产出的每一行，模板都要一字不差地复现
            for row in &migrated {
                assert!(
                    templated.contains(row),
                    "{key}：模板没有复现迁移里的字段 {row:?}\n模板产出：{templated:#?}"
                );
            }
            // 模板多出来的，只能是说好的那几个
            let mut surplus: Vec<&str> = templated
                .iter()
                .filter(|r| !migrated.contains(r))
                .map(|r| r.0.as_str())
                .collect();
            surplus.sort_unstable();
            assert_eq!(&surplus, extra_keys, "{key}：模板多出来的字段与预期不符");
        }
    }

    /// 库属性也是模板的一部分：到期锚点、日历标题的副标题、名称格小字、续费动作说法、
    /// 进日历描述的备注键——写错任何一个，到期时间线与 ICS 就跟预置库长得不一样。
    #[test]
    fn builtin_collection_attributes_match_their_templates() {
        let conn = crate::db::fresh_in_memory().unwrap();
        for id in ["subs", "sims", "vps"] {
            let t = template(id).unwrap();
            let got: (String, String, String, String, String) = conn
                .query_row(
                    "SELECT due_anchor, coalesce(subtitle,''), coalesce(subline,''),
                            coalesce(verb,''), coalesce(note_field,'')
                       FROM collections WHERE key=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap();
            assert_eq!(
                got,
                (
                    t.anchor.to_string(),
                    t.subtitle.to_string(),
                    t.subline.to_string(),
                    t.verb.to_string(),
                    t.note_field.to_string()
                ),
                "{id}：库属性与模板不一致"
            );
        }
    }

    /// 第一项必须是空白模板——前端的模板选择器默认选它。
    #[test]
    fn the_first_template_is_the_blank_one() {
        assert_eq!(TEMPLATES[0].id, "blank");
        assert!(TEMPLATES[0].extra.is_empty());
    }
}
