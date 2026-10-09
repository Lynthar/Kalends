//! 库（collections）与条目（items）：一份通用 CRUD 取代原先订阅 / SIM / VPS 三份同构实现。
//! 引擎要用的字段是 items 的真列，域字段挂在 extra JSON 里（键即字段键），与自定义列同一机制。

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Json, Router,
};
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::api::{bad, extra_json, extra_str, f, i, missing, s, safe_name, ApiError, R};
use crate::{db, engine, App};

const ANCHORS: &[&str] = &["next", "last"];

/// 续费之后从哪天起算：`schedule` 按原定日程（账单日不动）、`today` 从操作当天重新计时。
/// 与 `due_anchor` 正交，语义见 `engine::renew_to`。
const RENEW_FROMS: &[&str] = &["schedule", "today"];

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/collections", get(list).post(create))
        .route("/api/collections/templates", get(templates))
        .route("/api/collections/order", put(set_order))
        .route("/api/collections/{id}", put(update).delete(remove))
        .route("/api/collections/{key}/items", get(items_list).post(items_create))
        .route("/api/collections/{key}/items/order", put(items_order))
        .route("/api/items/bulk_delete", post(items_bulk_delete))
        // 条目更新是 PATCH 不是 PUT：语义就是局部更新（缺席即保持），见 `update_item`
        .route("/api/items/{id}", patch(items_update).delete(items_delete))
        .route("/api/items/{id}/renew", post(items_renew))
        .route("/api/items/{id}/logo", post(logo_set).delete(logo_clear))
        .route("/api/items/{id}/logo/fetch", post(logo_fetch))
        .route("/logos/{name}", get(logo_file))
}

/* ── 库 ─────────────────────────────────────────────────────────── */

const COLL_COLS: &str =
    "id,key,name,icon,due_anchor,subtitle,subline,verb,note_field,pos,builtin,renew_from";

fn coll_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
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
        "renew_from": r.get::<_, String>(11)?,
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
        .optional()?
        .ok_or_else(|| missing(format!("库不存在：{key}")))
}

fn anchor_of(conn: &Connection, id: i64) -> anyhow::Result<String> {
    Ok(conn.query_row(
        "SELECT due_anchor FROM collections WHERE id=?1",
        [id],
        |r| r.get(0),
    )?)
}

/// 新库的键：k<历史用过的最大编号 + 1>。**不能拿 rowid 派生**：SQLite 会复用删掉的
/// id，而删库按设计保留台账与通知日志的 kind 字符串——新库会捡到旧库的 kind，凭空
/// 继承旧账、通知去重也会误判。编号要越过所有"曾经用过"的痕迹，不只是现存的库。
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
    // 传错类型的键会被 `s()` 当成缺席、静默落回模板值——先把形状卡住
    crate::api::check_shape(&b, &["template", "name", "due_anchor", "renew_from", "icon", "verb"], &[], &[])?;
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
    let renew_from = s(&b, "renew_from")
        .or_else(|| tpl.map(|t| t.renew_from.to_string()))
        .unwrap_or_else(|| TPL.renew_from.into());
    if !RENEW_FROMS.contains(&renew_from.as_str()) {
        return Err(bad(format!("未知的续费起算方式：{renew_from}")).into());
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
        "INSERT INTO collections(key,name,icon,due_anchor,subtitle,subline,verb,note_field,pos,builtin,renew_from)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10)",
        params![
            key,
            name,
            take("icon", tpl.and_then(|t| opt(t.icon))),
            anchor,
            tpl.and_then(|t| opt(t.subtitle)),
            tpl.and_then(|t| opt(t.subline)),
            take("verb", tpl.and_then(|t| opt(t.verb))),
            tpl.and_then(|t| opt(t.note_field)),
            pos,
            renew_from
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

/// 模板的一个域字段；默认值见 `EXTRA`，写模板时只列与默认不同的键。
/// 模板只决定"库刚建好时长什么样"：落表后一律 builtin=0，与手加的自定义列同权。
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
    /// 续费之后从哪天起算，与 anchor 正交。默认 `schedule`（账单日不动）；
    /// 只有保号这类"窗口从操作当天重新计时"的才写 `today`
    renew_from: &'static str,
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
    renew_from: "schedule",
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
    // 订阅 / SIM / VPS 三个预置库也是模板：字段集与迁移 0008 对齐，由单测钉住不漂移。
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
        // 保号窗口本来就从实际充值那天重新计时——三个预置库里只有这个该是 today
        renew_from: "today",
        status: RENEWAL_STATUS_VOCAB,
        subline: "phone_number",
        note_field: "keepalive_action",
        // 保号周期恒为自定义天数：费用/周期/链接退进详情表单，不占表格列位。
        // cycle 必须注册（只是不上表）——没注册它正是「编辑清掉周期」一类事故的根。
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
                ftype: "tel",
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
                config: r#"{"tpl":"{cores}C / {ram_gb}G / {storage_gb}G {storage_type} / {port_gbps}Gbps / {traffic_tb}TB"}"#,
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
                "renew_from": t.renew_from,
                "verb": t.verb,
                // 域字段的显示名，供选择器预览；含只进详情表单（shown=0）的那些
                "fields": t.extra.iter().map(|f| f.name).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

/// 新建的库要能直接用：播一套默认字段集，锚点决定给哪一侧的日期字段，模板再加域字段。
/// 词表常量要按 SQLite `json()` 的形态写成紧凑一行、与迁移 0008 逐字节一致，
/// 模板对拍单测才对得上（`serde_json` 会按字母重排键，不能拿来压缩）。
const STATUS_VOCAB: &str = r#"[{"v":"Active","spend":1,"alert":1,"timeline":1},{"v":"Planned","spend":0,"alert":0,"timeline":0},{"v":"Ending","spend":0,"alert":0,"timeline":1},{"v":"Ended","spend":0,"alert":0,"timeline":0}]"#;

/// 三个续费库共用的六值词表：比通用词表多 Deferred（比价目录，记各档位供比较）
/// 与 Unused（未启用），两者都不计支出、不提醒、不上时间线。
const RENEWAL_STATUS_VOCAB: &str = r#"[{"v":"Active","spend":1,"alert":1,"timeline":1},{"v":"Planned","spend":0,"alert":0,"timeline":0},{"v":"Deferred","spend":0,"alert":0,"timeline":0},{"v":"Unused","spend":0,"alert":0,"timeline":0},{"v":"Ending","spend":0,"alert":0,"timeline":1},{"v":"Ended","spend":0,"alert":0,"timeline":0}]"#;

/// (键, 显示名, 类型, 数据源, 默认上表, 序)
type FieldDef = (&'static str, &'static str, &'static str, &'static str, i64, i64);

/// 到期模型决定注册哪一侧的日期字段。建库播种与**事后切换到期模型**共用这一份：
/// 切换那条路非补不可——否则 `due_from` 改读一个界面上根本造不出来的字段，
/// 整库到期日静默消失（旧列还显示着值，看着一切正常，时间线却空了）。
fn anchor_fields(anchor: &str) -> &'static [FieldDef] {
    if anchor == "next" {
        &[("next_renewal", "下次到期", "date", "col", 1, 40)]
    } else {
        &[
            ("last_renewed", "上次续费", "date", "col", 1, 40),
            ("left", "剩余天数", "num", "calc", 1, 41),
        ]
    }
}

fn seed_fields(
    conn: &Connection,
    key: &str,
    anchor: &str,
    tpl: Option<&Template>,
) -> anyhow::Result<()> {
    // 序号留了空档，模板的域字段插在 10 段
    let mut defs: Vec<FieldDef> = vec![
        ("name", "名称", "text", "col", 1, 1),
        ("status", "状态", "status", "col", 1, 2),
        // 币种不再是自己一列：它并进费用格里，跟着金额一起填（见 fx.rs / 迁移 0013）
        ("price", "费用", "num", "col", 1, 30),
        ("cycle", "周期", "sel", "col", 1, 32),
    ];
    defs.extend_from_slice(anchor_fields(anchor));
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
            "INSERT INTO fields(id,tbl,key,name,ftype,src,shown,pos,builtin,options)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9)
             ON CONFLICT(tbl,key) DO NOTHING",
            params![db::next_id(conn, "fields")?, key, k, name, ftype, src, shown, pos, options],
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
            "INSERT INTO fields(id,tbl,key,name,ftype,src,shown,pos,builtin,options,config)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?10)
             ON CONFLICT(tbl,key) DO NOTHING",
            params![
                db::next_id(conn, "fields")?,
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
    // 传错类型的键会被 `pick`/`take` 当成缺席、静默保持原值——先把形状卡住
    crate::api::check_shape(
        &b,
        &["name", "icon", "due_anchor", "renew_from", "subtitle", "subline", "verb", "note_field"],
        &["pos"],
        &[],
    )?;
    let conn = app.db.lock().unwrap();
    let cur = conn
        .query_row(
            &format!("SELECT {COLL_COLS} FROM collections WHERE id=?1"),
            [id],
            coll_row,
        )
        .optional()?
        .ok_or_else(|| missing("库不存在"))?;
    // 逐字段合并：只改传来的键，其余保留
    let pick = |k: &str| -> Option<String> { s(&b, k) };
    let anchor = pick("due_anchor").unwrap_or_else(|| cur["due_anchor"].as_str().unwrap().into());
    if !ANCHORS.contains(&anchor.as_str()) {
        return Err(bad(format!("未知的到期模型：{anchor}")).into());
    }
    let renew_from =
        pick("renew_from").unwrap_or_else(|| cur["renew_from"].as_str().unwrap().into());
    if !RENEW_FROMS.contains(&renew_from.as_str()) {
        return Err(bad(format!("未知的续费起算方式：{renew_from}")).into());
    }
    // 带了 name 键却是空串或 null 要拒：当缺席处理会静默留着原名并回 200，建库同样输入回 400
    if b.get("name").is_some() && pick("name").is_none() {
        return Err(bad("库名不能为空").into());
    }
    let name = pick("name").unwrap_or_else(|| cur["name"].as_str().unwrap().into());
    let take = |k: &str| -> Option<String> {
        if b.get(k).is_some() {
            pick(k)
        } else {
            cur[k].as_str().map(String::from)
        }
    };
    let pos = i(&b, "pos").unwrap_or_else(|| cur["pos"].as_i64().unwrap());
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE collections SET name=?1,icon=?2,due_anchor=?3,subtitle=?4,subline=?5,
         verb=?6,note_field=?7,pos=?8,renew_from=?9 WHERE id=?10",
        params![
            name,
            take("icon"),
            anchor,
            take("subtitle"),
            take("subline"),
            take("verb"),
            take("note_field"),
            pos,
            renew_from,
            id
        ],
    )?;
    // 换到期模型就把新锚点那侧的日期字段补进注册表（见 anchor_fields 的注释）。
    // ON CONFLICT DO NOTHING：已注册过就保持用户改过的显示名与上表设置，幂等。
    if anchor != cur["due_anchor"].as_str().unwrap_or_default() {
        let key = cur["key"].as_str().unwrap_or_default();
        for (k, fname, ftype, src, shown, fpos) in anchor_fields(&anchor) {
            tx.execute(
                "INSERT INTO fields(id,tbl,key,name,ftype,src,shown,pos,builtin,options)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,'[]')
                 ON CONFLICT(tbl,key) DO NOTHING",
                params![db::next_id(&tx, "fields")?, key, k, fname, ftype, src, shown, fpos],
            )?;
        }
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

// 库顺序：整份 id 序落成 pos，决定标签行的排列。
// 路由排在 `/api/collections/{id}` 之前——静态段优先于路径参数，"order" 不会被当成 id。
async fn set_order(State(app): State<App>, Json(b): Json<Value>) -> R {
    let ids = id_list(&b)?;
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
        .optional()?
        .ok_or_else(|| missing("库不存在"))?;
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

pub fn item_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "collection_id": r.get::<_, i64>(1)?,
        "name": r.get::<_, String>(2)?,
        "parent_id": r.get::<_, Option<i64>>(3)?,
        "status": r.get::<_, String>(4)?,
        "price": crate::db::as_real(r.get_ref(5)?),
        "currency": r.get::<_, Option<String>>(6)?,
        "cycle": r.get::<_, Option<String>>(7)?,
        "cycle_days": crate::db::as_int(r.get_ref(8)?),
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
    for r in &mut rows {
        let due = due_of(r, &anchor);
        r["due"] = json!(due.map(|d| d.to_string()));
        r["days_left"] = json!(due.map(|d| (d - today).num_days()));
    }
    Ok(rows)
}

/// 到期日：`due_anchor='next'` 直接读下次续费日，否则从上次续费按周期推一步。
pub fn due_of(r: &Value, anchor: &str) -> Option<NaiveDate> {
    engine::due_from(
        anchor,
        r["cycle"].as_str().unwrap_or(""),
        r["cycle_days"].as_i64(),
        r["next_renewal"].as_str(),
        r["last_renewed"].as_str(),
    )
}

async fn items_list(State(app): State<App>, Path(key): Path<String>) -> R {
    let conn = app.db.lock().unwrap();
    Ok(Json(json!(items_of(&conn, &key)?)))
}

/// 有形状类型（tel / url / email / date）的规范化。分寸：**只拦一眼可辨的垃圾，
/// 不拦"不够完整"**——存量里就有 `+44` 这种残缺值，400 掉等于让人打不开旧条目；
/// 可疑但可能是真的，交给界面标出来（`telSuspect`）。
pub fn normalize_shaped(ftype: &str, raw: &str) -> anyhow::Result<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    match ftype {
        "tel" => {
            // **折叠必须先于字符白名单**：粘来的号码常带全角字符、方向符与零宽字符，点号或 en dash
            // 当分隔——次序反了就把真号码 400 掉，报错里那个字符还可能根本看不见。
            let plain: String = t
                .chars()
                .filter(|c| !matches!(c, '\u{AD}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'))
                .map(|c| match c {
                    '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c), // 全角 ASCII
                    '.' | '\u{2013}' => ' ',
                    _ => c,
                })
                .collect();
            let folded = plain.split_whitespace().collect::<Vec<_>>().join(" ");
            if let Some(c) = folded
                .chars()
                .find(|c| !(c.is_ascii_digit() || " +-()".contains(*c)))
            {
                return Err(bad(format!("电话号码里不该出现「{c}」")));
            }
            if !folded.chars().any(|c| c.is_ascii_digit()) {
                return Err(bad("电话号码至少要有一位数字"));
            }
            Ok(folded)
        }
        "email" => {
            if t.split_whitespace().count() > 1 {
                return Err(bad("邮箱里不该有空格"));
            }
            // 只认最基本的形状：有且只有一个 @，两侧都不空，域名里得有点。
            // 再严就会误伤合法但少见的地址——RFC 5322 允许的东西比多数人以为的多得多。
            let (user, host) = t.split_once('@').ok_or_else(|| bad("邮箱要有一个 @"))?;
            if user.is_empty() || host.is_empty() || host.contains('@') {
                return Err(bad("邮箱的形状不对"));
            }
            if !host.contains('.') || host.starts_with('.') || host.ends_with('.') {
                return Err(bad("邮箱的域名部分不对"));
            }
            // 域名大小写不敏感，统一小写；用户名部分按规范是敏感的，原样保留
            Ok(format!("{user}@{}", host.to_lowercase()))
        }
        "url" => {
            if t.split_whitespace().count() > 1 {
                return Err(bad("网址里不该有空格"));
            }
            // 没写协议补 https://（裸串在 <a href> 里会被当成相对路径）；
            // 协议按 RFC 3986 不分大小写，认下来并统一成小写存。
            let full = match t.split_once("://") {
                Some((scheme, rest)) => format!("{}://{rest}", scheme.to_lowercase()),
                None => format!("https://{t}"),
            };
            let (scheme, rest) = full.split_once("://").unwrap_or(("", ""));
            if scheme != "http" && scheme != "https" {
                return Err(bad("网址只支持 http / https"));
            }
            let host = rest.split(['/', '?', '#']).next().unwrap_or("");
            if host.is_empty() || !host.contains('.') {
                return Err(bad("网址里看不出域名"));
            }
            Ok(full)
        }
        "date" => {
            // 界面的原生 <input type=date> 写不出坏值，接口与导入脚本能——坏日期会让
            // 条目掉出到期时间线。认得出的松散写法补齐而不是拒掉：这些日期是当字符串
            // 排序的，`2026-8-5` 不补零会排到 `2026-12-01` 后面。
            // 年份限四位：`%Y` 吃带符号与五位年，ICS 随之写出 9 位的 DTSTART
            let d = NaiveDate::parse_from_str(t, "%Y-%m-%d")
                .ok()
                .filter(|d| (1..=9999).contains(&d.year()))
                .ok_or_else(|| bad(format!("日期要写成 2026-08-15 这样的形状：{t}")))?;
            Ok(d.format("%Y-%m-%d").to_string())
        }
        _ => Ok(t.to_string()),
    }
}

/// 币种：2–6 位字母，统一存大写。**不卡死三位 ISO 码**（`USDT` 这类四位的要进得来）；
/// 拦的是一眼可辨的垃圾——坏币种一旦落库，那笔钱就永远不进支出统计。
pub fn normalize_currency(raw: &str) -> anyhow::Result<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    if !(2..=6).contains(&t.chars().count()) || !t.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(bad(format!("币种要写成 USD 这样的字母代码：{t}")));
    }
    Ok(t.to_uppercase())
}

/// 域名部分：url 值渲染与取图标都用它（`https://a.com/x?y` → `a.com`）。
pub fn url_host(raw: &str) -> Option<String> {
    let rest = raw.split_once("://").map_or(raw, |x| x.1);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split('@').next_back().unwrap_or(host); // 去掉 user:pass@
    (!host.is_empty() && host.contains('.')).then(|| host.to_lowercase())
}

/// 周期只收 engine 的封闭集（大小写不同的认下来）；集外的值落库后到期日算不出、续费推不动日期。
fn normalize_cycle(raw: &str) -> anyhow::Result<String> {
    let t = raw.trim().to_lowercase();
    if t.is_empty() || engine::CYCLES.contains(&t.as_str()) {
        return Ok(t);
    }
    Err(bad(format!("周期只能是 {}：{raw}", engine::CYCLES.join(" / "))))
}

/// 状态大小写不同、且恰好对上词表里一个值时换成词表写法；对不上的原样收，首页点名「状态不在词表里」——
/// 拒收会让导入在第一行就停下，失去「先导入、再补词表」的余地。
fn respell_status(conn: &Connection, coll_key: &str, raw: &str) -> anyhow::Result<String> {
    let t = raw.trim();
    let Some(vocab) = engine::status_vocab(conn, coll_key)? else { return Ok(t.into()) };
    if vocab.iter().any(|v| v == t) {
        return Ok(t.into());
    }
    let lower = t.to_lowercase();
    let mut hits = vocab.iter().filter(|v| v.to_lowercase() == lower);
    Ok(match (hits.next(), hits.next()) {
        (Some(v), None) => v.clone(),
        _ => t.into(),
    })
}

/// extra 里一个值按它那列的类型判；`null` 与 `""` 是清空，照收。多选收文本或文本数组：
/// 文本 / 单选 / 多选可互换呈现，多选列按文本呈现时写进来的就是文本。
fn extra_value(ftype: &str, name: &str, v: &Value) -> anyhow::Result<Value> {
    if v.is_null() || v.as_str() == Some("") {
        return Ok(v.clone());
    }
    let wrong = |kind: &str| bad(format!("「{name}」要填{kind}"));
    match ftype {
        "num" => v.is_number().then(|| v.clone()).ok_or_else(|| wrong("数字")),
        "multi" => match v {
            Value::String(_) => Ok(v.clone()),
            Value::Array(a) if a.iter().all(Value::is_string) => Ok(v.clone()),
            _ => Err(wrong("文本或文本列表")),
        },
        "date" | "tel" | "url" | "email" => Ok(Value::from(normalize_shaped(ftype, v.as_str().ok_or_else(|| wrong("文本"))?)?)),
        _ => v.is_string().then(|| v.clone()).ok_or_else(|| wrong("文本")),
    }
}

/// 条目值的形状规则，全项目只此一处（新建与更新走它，续费用它的币种那支）：按注册表类型与周期封闭集
/// 判这次请求带来的值，能规范的就地规范。`cur` 是这一行的现值（新建为 None）：extra 里与现值相同的键
/// 不判——extra 整份往返，陈年坏值否则会让这行的任何编辑都 400。
fn normalize_item(conn: &Connection, coll: i64, b: &mut Value, cur: Option<&Value>) -> anyhow::Result<()> {
    let key: String = conn.query_row("SELECT key FROM collections WHERE id=?1", [coll], |r| r.get(0))?;
    // 币种自迁移 0013 起不是注册字段（并进了费用格），注册表那圈循环读不到它
    if let Some(c) = b.get("currency").and_then(Value::as_str) {
        b["currency"] = json!(normalize_currency(c)?);
    }
    if let Some(c) = b.get("cycle").and_then(Value::as_str) {
        b["cycle"] = json!(normalize_cycle(c)?);
    }
    if let Some(st) = b.get("status").and_then(Value::as_str) {
        b["status"] = json!(respell_status(conn, &key, st)?);
    }
    // 两个日期真列不看注册表：锚点另一侧那列不注册，照样被读、被导出
    for k in ["next_renewal", "last_renewed"] {
        if let Some(v) = b.get(k).and_then(Value::as_str) {
            b[k] = json!(normalize_shaped("date", v)?);
        }
    }
    let mut stmt = conn.prepare("SELECT key, name, ftype, src FROM fields WHERE tbl=?1")?;
    let fields: Vec<(String, String, String, String)> = stmt
        .query_map([&key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (k, name, ftype, src) in fields {
        if src == "col" && matches!(ftype.as_str(), "tel" | "url" | "email" | "date") {
            if let Some(v) = b.get(&k).and_then(Value::as_str) {
                b[&k] = json!(normalize_shaped(&ftype, v)?);
            }
        }
        if src != "extra" {
            continue;
        }
        let Some(v) = b.get("extra").and_then(|e| e.get(&k)) else { continue };
        if cur.and_then(|c| c["extra"].get(&k)) == Some(v) {
            continue;
        }
        b["extra"][&k] = extra_value(&ftype, &name, v)?;
    }
    Ok(())
}

fn item_values(b: &Value) -> anyhow::Result<Vec<rusqlite::types::Value>> {
    use rusqlite::types::Value as V;
    // 空名是允许的：表尾「＋ 新建」直接插一行空行、就地填（Notion 同款），拦下它这条路就没了。
    // 界面上空名渲染成灰色「未命名」占位，通知与 ICS 同样兜底，不会输出空标题。
    let name = s(b, "name").unwrap_or_default();
    Ok(vec![
        V::from(name),
        i(b, "parent_id").map_or(V::Null, V::from),
        V::from(s(b, "status").unwrap_or_else(|| "Planned".into())),
        f(b, "price").map_or(V::Null, V::from),
        s(b, "currency").map_or(V::Null, V::from),
        s(b, "cycle").map_or(V::Null, V::from),
        i(b, "cycle_days").map_or(V::Null, V::from),
        s(b, "next_renewal").map_or(V::Null, V::from),
        s(b, "last_renewed").map_or(V::Null, V::from),
        s(b, "url").map_or(V::Null, V::from),
        s(b, "notes").map_or(V::Null, V::from),
        extra_str(b).map_or(V::Null, V::from),
    ])
}

// logo 不在可写列里：文件名由服务端生成、删条目按行内名字删文件——放开它就能把 A 的
// 文件名写进 B，删 B 时连 A 的图标一起删掉。上传/抓取/清除各有专用端点。
const WRITE_COLS: &str = "name,parent_id,status,price,currency,cycle,cycle_days,\
                          next_renewal,last_renewed,url,notes,extra";

/// 条目写入口的类型校验：出现的键必须是它该有的类型（`api::check_shape`），logo 带非空值
/// 直接拒——`null`/`""` 按「不在可写集」忽略，整行回读再 PATCH 回来的用法才过得去。
fn check_item_shape(b: &Value) -> anyhow::Result<()> {
    if b.get("logo").is_some_and(|v| !(v.is_null() || v.as_str() == Some(""))) {
        return Err(bad("图标不走这里：上传/抓取/清除各有专用端点"));
    }
    crate::api::check_shape(
        b,
        &["name", "status", "currency", "cycle", "next_renewal", "last_renewed", "url", "notes"],
        &["parent_id", "cycle_days"],
        &["price"],
    )
}

/// cycle='days' 缺天数就算不出到期日，周期还显示成 "Every 0 days"。判规范化之后的值；`cur` 是这一行的
/// 现值（新建为 None）。只在请求碰了这两个键之一时判：拿整行去判，库里一个陈年坏值就能把这行锁死
fn check_cycle_days(b: &Value, cur: Option<&Value>) -> anyhow::Result<()> {
    if b.get("cycle").is_some() || b.get("cycle_days").is_some() {
        let pick = |k: &str| b.get(k).or_else(|| cur.and_then(|c| c.get(k)));
        if pick("cycle").and_then(Value::as_str) == Some("days")
            && pick("cycle_days").and_then(Value::as_i64).is_none_or(|d| d < 1)
        {
            return Err(bad("自定义周期要填天数"));
        }
    }
    Ok(())
}

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
        .optional()?
        .ok_or_else(|| missing("父行不存在"))?;
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

/// extra 只收注册为 extra 列的键，外加这一行本来就挂着的（陈年孤儿键原样往返，旧行不会因此存不了）。
/// 别的键多半来自没刷新的页面：那一列刚被删掉，写进去就成了界面上看不见、还会进导出的孤儿值。
fn check_extra_keys(conn: &Connection, coll: i64, b: &Value, cur: Option<&Value>) -> anyhow::Result<()> {
    let Some(extra) = b.get("extra").and_then(Value::as_object) else { return Ok(()) };
    let mut stmt = conn.prepare(
        "SELECT f.key FROM fields f JOIN collections c ON c.key=f.tbl WHERE c.id=?1 AND f.src='extra'",
    )?;
    let known: std::collections::HashSet<String> =
        stmt.query_map([coll], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let held = cur.and_then(|c| c.get("extra")).and_then(Value::as_object);
    let stray: Vec<&str> = extra
        .keys()
        .filter(|k| !known.contains(*k) && !held.is_some_and(|h| h.contains_key(*k)))
        .map(String::as_str)
        .collect();
    if stray.is_empty() {
        return Ok(());
    }
    Err(bad(format!("这些列已不存在：{}——页面可能没刷新，刷新后再改", stray.join("、"))))
}

pub fn insert_item(conn: &Connection, coll: i64, b: &Value) -> anyhow::Result<i64> {
    check_item_shape(b)?;
    check_extra_keys(conn, coll, b, None)?;
    check_parent(conn, coll, None, i(b, "parent_id"))?;
    let mut b = b.clone();
    normalize_item(conn, coll, &mut b, None)?;
    check_cycle_days(&b, None)?;
    let b = &b;
    let mut vals = item_values(b)?;
    vals.insert(0, rusqlite::types::Value::from(coll));
    // 新行落在手动序末尾。pos 不在 WRITE_COLS 里，只在这里和 /items/order 两处写。
    let pos: i64 = conn.query_row(
        "SELECT COALESCE(MAX(pos),0)+1 FROM items WHERE collection_id=?1",
        [coll],
        |r| r.get(0),
    )?;
    vals.push(rusqlite::types::Value::from(pos));
    let tx = conn.unchecked_transaction()?;
    let id = db::next_id(&tx, "items")?;
    vals.insert(0, rusqlite::types::Value::from(id));
    tx.execute(
        &format!(
            "INSERT INTO items(id,collection_id,{WRITE_COLS},pos) VALUES({})",
            (1..=vals.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(",")
        ),
        rusqlite::params_from_iter(vals),
    )?;
    tx.commit()?;
    Ok(id)
}

/// 局部更新，**全项目只此一条**：请求里**出现**的列写入（`""` 与 `null` 都表示清空），**缺席**的列
/// 一个字节都不碰；`extra` 作为一个整体值走同一条规则。全量替换那套「body 漏一列就清一列」正是这条
/// 协议要根除的；只写出现的列，也让读不出的存量值（宽松读成了 null）不会被一次无关的保存清掉。
pub fn update_item(conn: &Connection, id: i64, b: &Value) -> anyhow::Result<()> {
    let cur = conn
        .query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id=?1"), [id], item_row)
        .optional()?
        .ok_or_else(|| missing("条目不存在"))?;
    check_item_shape(b)?;
    let coll = cur["collection_id"].as_i64().unwrap_or_default();
    check_extra_keys(conn, coll, b, Some(&cur))?;
    // 规范化**只作用在这次请求带来的键上**，所以要赶在合并之前：拿合并后的整行去过校验，
    // 等于让库里一个陈年坏值（接口或导入脚本造得出来）把这一行永久锁死——
    // 改任何别的字段都会被一个自己没碰过的字段 400 掉。
    let mut incoming = b.clone();
    normalize_item(conn, coll, &mut incoming, Some(&cur))?;
    check_cycle_days(&incoming, Some(&cur))?;
    // 父行规则同理只判请求带来的 parent_id：一条存量坏链接不该让这行连备注都改不了
    if incoming.get("parent_id").is_some() {
        check_parent(conn, coll, Some(id), i(&incoming, "parent_id"))?;
    }
    let (sets, mut vals): (Vec<String>, Vec<rusqlite::types::Value>) = WRITE_COLS
        .split(',')
        .map(str::trim)
        .zip(item_values(&incoming)?)
        .filter(|(c, _)| incoming.get(*c).is_some())
        .enumerate()
        .map(|(n, (c, v))| (format!("{c}=?{},", n + 1), v))
        .unzip();
    vals.push(rusqlite::types::Value::from(id));
    conn.execute(
        &format!(
            "UPDATE items SET {}updated_at=datetime('now') WHERE id=?{}",
            sets.concat(),
            vals.len()
        ),
        rusqlite::params_from_iter(vals),
    )?;
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
    // 读不出图标名就整条别删：当成"没图标"删掉行，文件成孤儿且无人知晓。行不存在仍是幂等成功
    let logo: Option<String> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .optional()?
        .flatten();
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

/// 批量端点的 ids 数组。掺了非整数就整体拒：静默滤掉等于
/// 「说删 5 个、实际删 3 个」还不吭声。
pub fn id_list(b: &Value) -> anyhow::Result<Vec<i64>> {
    let arr = b.get("ids").and_then(|x| x.as_array()).ok_or_else(|| bad("缺少 ids"))?;
    let ids: Vec<i64> = arr
        .iter()
        .map(|x| x.as_i64().ok_or_else(|| bad("ids 要是整数数组")))
        .collect::<anyhow::Result<_>>()?;
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
    // 报真正删掉的条数，不是请求里的 id 个数——不存在的 id 也算进去的话，这个数字就是编的
    let mut deleted = 0usize;
    for id in &ids {
        // 读不出图标名就整批回滚，别把它当成"没图标"——那样文件成孤儿且无人知晓
        let logo: Option<String> = tx
            .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .flatten();
        logos.push(logo);
        deleted += tx.execute("DELETE FROM items WHERE id=?1", [id])?;
    }
    tx.commit()?;
    for logo in logos {
        remove_logo_file(&app, logo);
    }
    Ok(Json(json!({ "ok": true, "deleted": deleted })))
}

/// 记一笔续费：写台账并按库的到期模型推进日期。
/// `anchor='next'` 推进 `next_renewal`（逾期则连推到今天之后），`anchor='last'` 把上次续费记为今天。
type RenewRow = (
    String,
    String,
    String,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    String,
    String,
);

pub fn renew_item(conn: &Connection, id: i64, b: &Value) -> anyhow::Result<Value> {
    // amount 传错类型会被 `f()` 当成缺席、静默回落到条目价格——台账会记下一个没人填过的数
    crate::api::check_shape(b, &["currency", "note"], &[], &["amount"])?;
    // 币种与条目同一规范化：台账记下就改不了
    let paid_in = s(b, "currency").map(|c| normalize_currency(&c)).transpose()?;
    let row: Option<RenewRow> = conn
        .query_row(
            "SELECT c.key, c.due_anchor, c.renew_from, i.price, i.currency,
                    i.cycle, i.cycle_days, i.next_renewal, i.last_renewed, i.name, c.name
             FROM items i JOIN collections c ON c.id=i.collection_id WHERE i.id=?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    crate::db::as_real(r.get_ref(3)?),
                    r.get(4)?,
                    r.get(5)?,
                    crate::db::as_int(r.get_ref(6)?),
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            },
        )
        .optional()?;
    let Some((
        key,
        anchor,
        renew_from,
        price,
        currency,
        cycle,
        cycle_days,
        next,
        last,
        item_name,
        coll_name,
    )) = row
    else {
        return Err(missing("条目不存在"));
    };
    let today = engine::today();
    // 记账与推日期是一件事：只落成一半的话，账记了而到期日没动，界面照旧显示逾期，
    // 而台账已经声称这笔付过了——"台账=事实"这条承诺就断在这里
    let tx = conn.unchecked_transaction()?;
    // 名字当场钉进台账。只记 (kind, item_id) 的话，条目一删这笔账就没了名字——
    // 台账是事实记录，得能自证，不该跟着当前条目变。
    tx.execute(
        "INSERT INTO renewal_ledger(kind,item_id,renewed_at,amount,currency,note,item_name,coll_name)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            key,
            id,
            today.to_string(),
            f(b, "amount").or(price),
            paid_in.or(currency),
            s(b, "note"),
            item_name,
            coll_name,
        ],
    )?;
    // 日期该落在哪天由 engine 那个纯函数说了算——四种组合都在那里，且有单测钉着
    let day = |s: &Option<String>| {
        s.as_deref()
            .and_then(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").ok())
    };
    let cy = cycle.as_deref().unwrap_or_default();
    let moved = engine::renew_to(
        &anchor,
        &renew_from,
        cy,
        cycle_days,
        day(&next),
        day(&last),
        today,
    );
    let col = if anchor == "next" {
        "next_renewal"
    } else {
        "last_renewed"
    };
    if let Some(d) = moved {
        tx.execute(
            &format!("UPDATE items SET {col}=?1,updated_at=datetime('now') WHERE id=?2"),
            params![d.to_string(), id],
        )?;
    }
    tx.commit()?;
    // 顺带回一个 due：界面据此如实报出"下次到期是哪天"。锚点被拽走过的人一眼能看见，
    // 而算日期的仍然只有 engine 一处——前端自己再算一遍就又是两份会各说各话的实现
    let moved = moved.map(|d| d.to_string());
    let due = engine::due_from(
        &anchor,
        cy,
        cycle_days,
        if anchor == "next" { moved.as_deref() } else { None },
        if anchor == "next" { None } else { moved.as_deref() },
    );
    Ok(json!({
        col: moved,
        "due": due.map(|d| d.to_string()),
    }))
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

/// 按字节认出图片格式。放行的集合与 `logo_bytes_ok` 完全一致（就是拿它逐个试），
/// svg 排最后——它是唯一一条看文本前缀的启发式判据，最松。
fn sniff_image_ext(b: &[u8]) -> Option<&'static str> {
    ["png", "jpg", "gif", "webp", "ico", "svg"]
        .into_iter()
        .find(|ext| logo_bytes_ok(ext, b))
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
        .optional()?;
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
    // 文件名带秒级时间戳：同一秒传第二张就新旧同名，删"旧文件"会把刚写的新文件
    // 一起删掉（库里记着名字、文件没了，图标 404）。同名不删——write 已原地覆盖。
    if old.as_deref() != Some(name.as_str()) {
        remove_logo_file(app, old);
    }
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

/// 取图标只连**条目自己那个站**、只走这几条常规路径，不经第三方 favicon 服务
/// （那等于把整份订阅域名清单告诉别人）。默认关着的出网，用户点一下才发生。
const FAVICON_PATHS: &[&str] = &["/favicon.ico", "/favicon.png", "/apple-touch-icon.png"];

/// 一个 IP 是否算"公网"（纯函数，好穷举测试）。服务端替用户发请求前必须挡住内网，
/// 否则「取图标」就成了替人探测内网的按钮（`image_path_ok` 是同一种防线）。
fn public_ip_ok(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                // 100.64.0.0/10 运营商级 NAT，Tailscale 也用这一段
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1])))
        }
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments();
            let unique_local = (seg[0] & 0xfe00) == 0xfc00; // fc00::/7
            let link_local = (seg[0] & 0xffc0) == 0xfe80; // fe80::/10
            // ::ffff:a.b.c.d 形式的 IPv4 映射地址要按里面那个 v4 判，否则 ::ffff:127.0.0.1 会漏过
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_ip_ok(&std::net::IpAddr::V4(v4));
            }
            // NAT64 前缀里的地址同理：网关会把它翻成嵌着的 IPv4 去连
            if let Some(v4s) = nat64_embedded(v6) {
                return v4s.iter().all(|v4| public_ip_ok(&std::net::IpAddr::V4(*v4)));
            }
            !(v6.is_loopback() || v6.is_unspecified() || unique_local || link_local)
        }
    }
}

/// NAT64 前缀里嵌着的 IPv4，一种布局一个候选。`64:ff9b::/96`（RFC 6052 熟知前缀）只有 /96
/// 一种；`64:ff9b:1::/48`（RFC 8215 本地用）部署时前缀可长到 /96，只按 /96 读会把 /64
/// 布局里的 10.0.0.5 读成 5.0.0.0 而放行，所以成形的布局都要给出来、全部过 v4 规则。
fn nat64_embedded(v6: &std::net::Ipv6Addr) -> Option<Vec<std::net::Ipv4Addr>> {
    let seg = v6.segments();
    let layouts: &[usize] = if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        &[96]
    } else if seg[..3] == [0x64, 0xff9b, 1] {
        &[48, 56, 64, 96]
    } else {
        return None;
    };
    let b = v6.octets();
    Some(layouts.iter().filter_map(|&l| rfc6052_v4(&b, l)).collect())
}

/// RFC 6052 §2.2 的布局：前缀之后嵌 IPv4，第 8 字节 `u` 必须为零、嵌完之后的后缀必须为零，
/// 不成形的布局给 None（/96 布局把 16 字节用满，没有 u 与后缀）。
fn rfc6052_v4(b: &[u8; 16], prefix_len: usize) -> Option<std::net::Ipv4Addr> {
    let (v4, suffix): ([u8; 4], &[u8]) = match prefix_len {
        48 => ([b[6], b[7], b[9], b[10]], &b[11..]),
        56 => ([b[7], b[9], b[10], b[11]], &b[12..]),
        64 => ([b[9], b[10], b[11], b[12]], &b[13..]),
        96 => return Some(std::net::Ipv4Addr::from([b[12], b[13], b[14], b[15]])),
        _ => return None,
    };
    (b[8] == 0 && suffix.iter().all(|&x| x == 0)).then(|| std::net::Ipv4Addr::from(v4))
}

/// 解析出来的地址全都得是公网。空解析结果按拒绝算。
fn resolved_ips_ok(ips: &[std::net::IpAddr]) -> bool {
    !ips.is_empty() && ips.iter().all(public_ip_ok)
}

/// 主机名去掉端口与 IPv6 方括号。
fn bare_host(host: &str) -> &str {
    match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(host),
    }
}

/// 字面形状这一关：明显的本机名与字面内网地址直接拒（不带点的主机、含裸 IPv6 字面量，在 `url_host`
/// 就取不出主机名，到不了这里）。光看字面拦不住"公共域名解析到 127.0.0.1"（localtest.me），
/// 发请求前还要过 `resolve_public`。
fn public_host_ok(host: &str) -> bool {
    // 主机名不分大小写，先统一再比后缀——否则 FOO.LOCAL 字面关直接放过
    let bare = bare_host(host).to_ascii_lowercase();
    if bare.is_empty() || bare == "localhost" || bare.ends_with(".localhost") || bare.ends_with(".local") {
        return false;
    }
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return public_ip_ok(&ip);
    }
    bare.contains('.')
}

/// 字面 + 解析结果双重校验，**并把校验过的地址交回去钉死**；None＝不许连，
/// **每一跳重定向都要重新过这里**。只校验不钉的话 reqwest 连接时会再解析一次，
/// 两次之间 DNS 可以翻脸（rebinding / TOCTOU）。配了代理时由代理解析，这里都不生效。
async fn resolve_public(host: &str, port: u16) -> Option<std::net::SocketAddr> {
    if !public_host_ok(host) {
        return None;
    }
    let bare = bare_host(host);
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return Some(std::net::SocketAddr::new(ip, port)); // 字面 IP 上面已验过
    }
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((bare, port)).await.ok()?.collect();
    let ips: Vec<std::net::IpAddr> = addrs.iter().map(std::net::SocketAddr::ip).collect();
    // 有一条落内网就整体拒；否则钉住第一条——钉的必须是刚校验过的那一批里的
    resolved_ips_ok(&ips).then(|| addrs[0])
}

/// 响应体上限。reqwest 没有默认上限，唯一边界是 30s 总超时＝「带宽 × 30s」全进内存；
/// SSRF 防线管"连到哪"，这条管"读多少"，是正交的缺口。
const ICON_MAX: usize = 2 << 20; // 图标：2 MB（set_logo 还会按 1 MB 再卡一道）
const PAGE_MAX: usize = 512 << 10; // 发现页：512 KB

/// 只读前 `limit` 字节就收手。发现页只看 `<head>` 里的 link 标签，后面再多也没用；
/// 半个多字节字符被截断由 `from_utf8_lossy` 兜着（`icon_links_in` 本就按字符切）。
async fn body_head(resp: reqwest::Response, limit: usize) -> Vec<u8> {
    let mut resp = resp;
    let mut out = Vec::new();
    while out.len() < limit {
        match resp.chunk().await {
            Ok(Some(chunk)) => out.extend_from_slice(&chunk),
            _ => break,
        }
    }
    out.truncate(limit);
    out
}

/// 从首页的 `<link rel="icon">` 里找图标地址；取不到、超时、页面过大都当"没发现"，
/// 调用方退回常规路径。只做一次 GET 与正则式粗解析——为这点事引 HTML 解析器不值当。
async fn discover_icon_paths(proxy: &str, ua: &str, scheme: &str, host: &str) -> Vec<String> {
    let Ok(resp) = get_public(proxy, &format!("{scheme}://{host}/"), ua).await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let body = body_head(resp, PAGE_MAX).await;
    icon_links_in(&String::from_utf8_lossy(&body), scheme, host)
}

/// 发一个 GET，自己跟重定向，**每一跳都重新校验目标主机**——reqwest 默认跟 10 跳
/// 且不回头问，`https://正常站/x → 302 → http://10.0.0.5/` 会一路直达内网。
async fn get_public(proxy: &str, url: &str, ua: &str) -> Result<reqwest::Response, String> {
    let mut current = url.to_string();
    for _ in 0..4 {
        let parsed = reqwest::Url::parse(&current).map_err(|_| format!("网址不对：{current}"))?;
        let host = parsed.host_str().unwrap_or("").to_string();
        let port = parsed.port_or_known_default().unwrap_or(443);
        let Some(addr) = resolve_public(&host, port).await else {
            return Err(format!("{host} 指向内网或本机，不去连它"));
        };
        // 每跳一个钉死地址的客户端：钉的就是刚校验过的那个地址，reqwest 不会再解析一次
        let client = crate::notify::http_client_pinned(proxy, &host, addr)
            .map_err(|e| format!("建连接失败：{e}"))?;
        let resp = client
            .get(&current)
            .header("User-Agent", ua)
            .send()
            .await
            .map_err(|e| format!("连不上 {host}：{e}"))?;
        if !resp.status().is_redirection() {
            return Ok(resp);
        }
        let Some(loc) = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok())
        else {
            return Ok(resp); // 3xx 但没给 Location，当普通响应交给调用方判
        };
        // 相对跳转要按当前地址解析，否则 `Location: /favicon.ico` 会解析失败
        current = parsed
            .join(loc)
            .map_err(|_| format!("跟不动这个跳转：{loc}"))?
            .to_string();
    }
    Err("重定向太多".into())
}

/// 从 HTML 里挑出图标地址（纯函数，好上单测）。**一律按字符切，不能按字节**：
/// 页面里一个多字节字符就能让 `&body[..n]` 落在字符中间 panic、带走整个请求线程
/// （与 `ics::fold` 同一个坑）。
fn icon_links_in(body: &str, scheme: &str, host: &str) -> Vec<String> {
    let head: String = body.chars().take(200_000).collect();
    let mut out = Vec::new();
    for tag in head
        .split('<')
        .filter(|t| t.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("link")))
    {
        // rel 得**真的**是图标：只看 rel 属性自己的值，
        // 否则 `<link rel="stylesheet" href="/icon-theme.css">` 也会被捡进来
        if !attr_value(tag, "rel").is_some_and(|v| v.to_lowercase().contains("icon")) {
            continue;
        }
        let Some(href) = attr_value(tag, "href").map(str::trim) else {
            continue;
        };
        if href.is_empty() || href.starts_with("data:") {
            continue;
        }
        // 协议相对地址跟着条目自己那个网址的协议走，别一律拼 https
        let abs = if href.starts_with("//") {
            format!("{scheme}:{href}")
        } else {
            href.to_string()
        };
        // 只跟到同一个站：href 可能指向别的域名，那就超出"只连你订阅的那个站"了
        if abs.starts_with("http") && url_host(&abs).as_deref() != Some(host) {
            continue;
        }
        out.push(abs);
    }
    out.truncate(4);
    out
}

/// 取标签里某个属性的引号值，属性名按 ASCII 大小写不敏感匹配。直接在原串上按字节扫
/// （属性名、`=`、引号全是 ASCII，落点必是字符边界），不造小写副本定位——
/// `to_lowercase` 可能改变字节长度，索引就对不上了。
fn attr_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let b = tag.as_bytes();
    let n = name.as_bytes();
    let mut i = 0usize;
    while i + n.len() <= b.len() {
        if !b[i..i + n.len()].eq_ignore_ascii_case(n) {
            i += 1;
            continue;
        }
        // 名字前面得是分界，否则 `rel` 会命中 `hreflang` 这类属性里的子串
        let boundary = i == 0 || b[i - 1].is_ascii_whitespace();
        let mut j = i + n.len();
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if !boundary || j >= b.len() || b[j] != b'=' {
            i += 1;
            continue;
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= b.len() || (b[j] != b'"' && b[j] != b'\'') {
            return None;
        }
        let quote = b[j];
        let start = j + 1;
        let end = start + b[start..].iter().position(|c| *c == quote)?;
        return tag.get(start..end);
    }
    None
}

/// 从条目的网址取 favicon 存成它的图标。
async fn logo_fetch(State(app): State<App>, Path(id): Path<i64>, Json(b): Json<Value>) -> R {
    // 整轮总截止：候选最多 8 条、每条各 30s 上限，对着黑洞式丢包的目标能停四分钟；
    // 常见失败都在秒级，这道闸只砍最坏的尾巴
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(45);
    let (raw, proxy) = {
        let conn = app.db.lock().unwrap();
        let stored: Option<Option<String>> = conn
            .query_row("SELECT url FROM items WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        let Some(stored) = stored else {
            return Err(missing("条目不存在").into());
        };
        let raw = s(&b, "url").or(stored).unwrap_or_default();
        // 代理读不出来就整个不出网：折成空串等于绕过用户配的代理直连，而直连成功时无人知晓
        (raw, crate::db::get_setting(&conn, "meta.proxy")?.unwrap_or_default())
    };
    if raw.trim().is_empty() {
        return Err(bad("这个条目还没有网址").into());
    }
    let full = normalize_shaped("url", &raw)?;
    let host = url_host(&full).ok_or_else(|| bad("网址里看不出域名"))?;
    if !public_host_ok(&host) {
        return Err(bad("只能从公网站点取图标").into());
    }
    // 协议沿用条目自己那个网址：恒拼 https 的话，http-only 站点每条路径都在做
    // TLS 握手、全数"连不上"，报出来的方向还全错
    let scheme = full.split_once("://").map_or("https", |x| x.0);
    Ok(Json(grab_logo(&app, id, &proxy, scheme, &host, DEADLINE).await?))
}

/// 挨个候选地址取图标，取到第一张可用的就存成条目 `id` 的图标。`budget` 是整轮总截止。
async fn grab_logo(app: &App, id: i64, proxy: &str, scheme: &str, host: &str, budget: std::time::Duration) -> anyhow::Result<Value> {
    // 不带 UA 会被一部分站点当爬虫直接 403（update-fx-baseline.py 同一个坑）
    const UA: &str = "kalends-icon-fetch";
    // 截止时刻管住**每一次**网络等待：只在候选之间判的话，一个候选跟几跳慢速重定向就能拖过两倍
    let deadline = tokio::time::Instant::now() + budget;
    let mut last = String::from("没找到图标");
    // 先问网页自己：多数站点的图标不在 /favicon.ico，而是 <link rel="icon"> 指到别处。
    // 取不到就退回常规路径挨个试。
    let mut paths: Vec<String> =
        tokio::time::timeout_at(deadline, discover_icon_paths(proxy, UA, scheme, host)).await.unwrap_or_default();
    paths.extend(FAVICON_PATHS.iter().map(|p| (*p).to_string()));
    for path in paths {
        let target = if path.starts_with("http") {
            path.clone()
        } else {
            format!("{scheme}://{host}{}", if path.starts_with('/') { path.clone() } else { format!("/{path}") })
        };
        let fetched = tokio::time::timeout_at(deadline, async {
            let resp = get_public(proxy, &target, UA).await?;
            if !resp.status().is_success() {
                return Err(format!("{host} 返回 {}", resp.status()));
            }
            crate::notify::body_capped(resp, ICON_MAX).await
        })
        .await;
        let bytes = match fetched {
            Ok(Ok(x)) => x,
            Ok(Err(e)) => {
                last = e;
                continue;
            }
            Err(_) => {
                last = format!("{last}；试了 {}s 还没结果，先收手", budget.as_secs());
                break;
            }
        };
        // 格式按**字节**认，不从 URL 后缀猜：/favicon.ico 返回 PNG 字节是极常见的部署，
        // 现代站点的 <link rel=icon href=/icon> 干脆没有扩展名——按后缀猜会把可用的
        // 图标误拒掉。放行集合没放宽，只是把"声明"从猜测换成事实
        let Some(ext) = sniff_image_ext(&bytes) else {
            last = format!("{target} 取到的不是可用图片");
            continue;
        };
        // 体积上限与旧文件清理仍由 set_logo 兜着
        let conn = app.db.lock().unwrap();
        match set_logo(app, &conn, id, ext, &bytes) {
            Ok(name) => return Ok(json!({ "logo": name, "from": target })),
            Err(e) => last = format!("{target} 取到的不是可用图片（{e}）"),
        }
    }
    // Cloudflare 前置的站按 TLS 指纹挡非浏览器客户端，改请求头绕不过去（伪装指纹
    // 要引重依赖、性质上是欺骗，不做）——老实告诉用户手动传一张
    Err(bad(format!("{last}；这个站可能不给自动抓取，可以手动选一张图片")))
}

pub fn clear_logo(app: &App, conn: &Connection, id: i64) -> anyhow::Result<()> {
    let old: Option<Option<String>> = conn
        .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
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

// 文件名先过 safe_name 再拼路径：放行分隔符或 `..` 就是一次任意文件读
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
        Some("jpg" | "jpeg") => "image/jpeg",
        // 写入口只落上面这几种后缀；别的文件不是图标，不替它猜类型
        _ => return Ok(StatusCode::NOT_FOUND.into_response()),
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
    use crate::call;
    use crate::db::one;

    /// 删掉 id 最大的那条再新建，新条目不能捡回旧号：通知去重键、放锁期间的在途请求都拿 id
    /// 当身份，旧号的记录（哪怕晚到）会让新条目被判成「已发过」而静默漏提醒。
    #[test]
    fn deleting_the_newest_item_does_not_hand_its_id_to_the_next_one() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll = coll(&conn, "subs");
        let old = insert_item(&conn, coll, &json!({ "name": "Old" })).unwrap();
        conn.execute("DELETE FROM items WHERE id=?1", [old]).unwrap();
        let new = insert_item(&conn, coll, &json!({ "name": "New" })).unwrap();
        assert!(new > old, "{old} → {new}");
    }

    /// 日期与币种：界面挡得住（原生 date 控件、币种下拉），接口与导入脚本挡不住，
    /// 而写坏的后果都不出声——坏日期掉出到期时间线、坏币种进不了支出统计。
    #[test]
    fn dates_and_currencies_are_shaped_at_the_write_entry() {
        // 日期：只认 ISO 形状，空值仍然放行（不填＝没这个日期）
        assert_eq!(normalize_shaped("date", "2026-08-15").unwrap(), "2026-08-15");
        assert_eq!(normalize_shaped("date", "  ").unwrap(), "");
        // 认得出的松散写法补齐成标准形状——这些日期是当字符串排序的，没补零会排错位
        assert_eq!(normalize_shaped("date", "2026-8-5").unwrap(), "2026-08-05");
        for bad_one in ["2026/08/15", "明天", "2026-13-01", "20260815", "2026-02-30"] {
            assert!(normalize_shaped("date", bad_one).is_err(), "{bad_one} 不该放行");
        }
        // 币种：统一大写，两到六位字母
        assert_eq!(normalize_currency(" usd ").unwrap(), "USD");
        assert_eq!(normalize_currency("USDT").unwrap(), "USDT"); // 四位的也得进得来
        assert_eq!(normalize_currency("").unwrap(), "");
        for bad_one in ["这不是ISO码", "US1", "U", "TOOLONGCODE", "US$"] {
            assert!(normalize_currency(bad_one).is_err(), "{bad_one} 不该放行");
        }
    }

    /// 存量里一个不合形的值不能把整行锁死：校验只针对**这次写进来的**键。
    /// 否则改任何别的字段都会被一个自己没碰过的字段 400 掉——而这些值正是
    /// 界面挡得住、接口挡不住那批（校验是后来才加的，历史数据没跟着洗）。
    #[test]
    fn a_bad_stored_value_does_not_lock_the_row() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll = coll(&conn, "subs");
        // 绕开写入口塞一个坏币种与坏日期（接口与导入脚本历史上都造得出来）
        conn.execute(
            "INSERT INTO items(collection_id,name,status,currency,next_renewal)
             VALUES(?1,'旧条目','Active','人民币','2026/08/05')",
            [coll],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        update_item(&conn, id, &json!({ "notes": "改个备注" })).unwrap();
        let (notes, currency, due): (String, String, String) = conn
            .query_row(
                "SELECT notes, currency, next_renewal FROM items WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(notes, "改个备注");
        // 没碰的键原样留着：治它要另开一条路，而不是让人打不开自己的条目
        assert_eq!(currency, "人民币");
        assert_eq!(due, "2026/08/05");
        // 真去改那两个字段时，校验照样拦得住
        assert!(update_item(&conn, id, &json!({ "currency": "人民币" })).is_err());
        assert!(update_item(&conn, id, &json!({ "next_renewal": "2026/08/05" })).is_err());
        // 改成合形的值就该放行，顺带把旧值治好
        update_item(&conn, id, &json!({ "currency": "cny", "next_renewal": "2026-8-5" })).unwrap();
        let (currency, due): (String, String) = conn
            .query_row("SELECT currency, next_renewal FROM items WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((currency.as_str(), due.as_str()), ("CNY", "2026-08-05"));
    }

    /// 传错类型的键必须 400 且一字不动：取值函数读不出来就给 None，「出现即写入」的
    /// 协议下那是一次静默清空——价格传成字符串，响应还是 200，价格却成了 NULL。
    #[test]
    fn a_wrongly_typed_value_is_refused_and_the_row_is_untouched() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll = coll(&conn, "subs");
        let id = insert_item(
            &conn,
            coll,
            &json!({ "name": "类型校验", "price": 12.5, "currency": "USD", "extra": { "category": "甲" } }),
        )
        .unwrap();
        for bad_body in [
            json!({ "price": "不是数字" }),
            json!({ "extra": ["不是对象"] }),
            json!({ "extra": "也不是" }),
            json!({ "name": 123 }),
            json!({ "cycle_days": 2.5 }),
            json!({ "parent_id": "5" }),
        ] {
            assert!(update_item(&conn, id, &bad_body).is_err(), "{bad_body} 不该放行");
        }
        let (price, extra): (Option<f64>, String) = conn
            .query_row("SELECT price, extra FROM items WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(price, Some(12.5), "被拒的请求不能碰行数据");
        assert!(extra.contains("甲"), "{extra}");
        // 清空按协议仍然走：null 与空串都行
        update_item(&conn, id, &json!({ "price": null, "extra": null })).unwrap();
        let (price, extra): (Option<f64>, Option<String>) = conn
            .query_row("SELECT price, extra FROM items WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((price, extra), (None, None));
    }

    /// extra 只收注册过的列键：没刷新的页面会把刚删掉的那列连键带值写回来，成了界面看不见的孤儿值。
    /// 这一行本来就挂着的键原样往返——不能让一条陈年孤儿键把整行锁死。
    #[test]
    fn extra_takes_registered_keys_and_the_ones_the_row_already_holds() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll = coll(&conn, "subs");
        let err = insert_item(&conn, coll, &json!({ "name": "新", "extra": { "c999": "x" } })).unwrap_err();
        assert!(err.to_string().contains("c999"), "{err}");
        let id = insert_item(&conn, coll, &json!({ "name": "旧行", "extra": { "category": "AI" } })).unwrap();
        conn.execute(r#"UPDATE items SET extra='{"category":"AI","c7":"陈年"}' WHERE id=?1"#, [id]).unwrap();
        update_item(&conn, id, &json!({ "extra": { "category": "Tools", "c7": "陈年" } })).unwrap();
        let more = json!({ "extra": { "category": "Tools", "c7": "陈年", "c8": "新孤儿" } });
        assert!(update_item(&conn, id, &more).is_err());
        let extra: String = crate::db::one(&conn, "SELECT extra FROM items WHERE id=?1", [id]);
        assert_eq!(serde_json::from_str::<Value>(&extra).unwrap(), json!({ "category": "Tools", "c7": "陈年" }));
    }

    /// logo 不是通用可写列：文件名由服务端生成、删条目按行内名字删文件——放开它
    /// 就能把 A 的文件名写进 B，删 B 时连 A 的图标一起删掉。
    #[test]
    fn the_logo_column_cannot_be_written_through_the_generic_patch() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll = coll(&conn, "subs");
        let id = insert_item(&conn, coll, &json!({ "name": "甲" })).unwrap();
        assert!(update_item(&conn, id, &json!({ "logo": "item-9-9.png" })).is_err());
        assert!(insert_item(&conn, coll, &json!({ "name": "乙", "logo": "item-9-9.png" })).is_err());
        // 整行回读再 PATCH 回来的形状（logo:null）要能过：它按「不在可写集」忽略
        update_item(&conn, id, &json!({ "logo": null, "notes": "改备注" })).unwrap();
        let (logo, notes): (Option<String>, String) = conn
            .query_row("SELECT logo, notes FROM items WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(logo, None);
        assert_eq!(notes, "改备注");
    }

    /// 局部更新：缺席即保持、出现即写入、`""` 与 `null` 都是清空、`extra` 作为一个整体值。
    /// 这条是写入协议的地基，它一松，前端就得重新长出"先铺整行再覆盖"的补偿代码。
    #[test]
    fn a_patch_only_touches_the_keys_it_carries() {
        let conn = fresh();
        let id = insert_item(&conn, coll(&conn, "subs"), &json!({
            "name": "Netflix", "price": 15.49, "currency": "USD", "cycle": "monthly",
            "next_renewal": "2026-09-01", "extra": { "category": "Streaming", "payment_method": "Visa" },
        }))
        .unwrap();
        conn.execute("UPDATE items SET logo='item-1.png' WHERE id=?1", [id]).unwrap();
        let row = || conn.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id=?1"), [id], item_row).unwrap();

        // 只发一个键：其余原样，连表单里根本没有的 logo 也在
        update_item(&conn, id, &json!({ "name": "改过名" })).unwrap();
        let got = row();
        assert_eq!(got["name"], json!("改过名"));
        assert_eq!(got["price"], json!(15.49));
        assert_eq!(got["logo"], json!("item-1.png"));
        assert_eq!(got["extra"]["payment_method"], json!("Visa"));

        // 清空要显式说出来：null 与空串都算，别的键不受连累
        update_item(&conn, id, &json!({ "price": null, "next_renewal": "" })).unwrap();
        let got = row();
        assert_eq!(got["price"], Value::Null);
        assert_eq!(got["next_renewal"], Value::Null);
        assert_eq!(got["currency"], json!("USD"));

        // extra 是一个整体值：出现即整份替换（少写的键就是要删的键）
        update_item(&conn, id, &json!({ "extra": { "category": "AI" } })).unwrap();
        assert_eq!(row()["extra"], json!({ "category": "AI" }));
    }

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
        // 模板多出来的字段只有 SIM 的三列：预置库没注册费用/周期/链接，模板注册上
        // 但不上表——这是有意为之的修正（没注册 cycle 曾让编辑清掉周期），不是漂移。
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

    /// 库属性也是模板的一部分，写错任何一个，删掉预置库再照模板建回来行为就变了。
    /// `renew_from` 尤其要钉住（迁移 0017 把 vps 置 schedule、sims 置 today）。
    #[test]
    fn builtin_collection_attributes_match_their_templates() {
        let conn = crate::db::fresh_in_memory().unwrap();
        for id in ["subs", "sims", "vps"] {
            let t = template(id).unwrap();
            let got: (String, String, String, String, String, String) = conn
                .query_row(
                    "SELECT due_anchor, renew_from, coalesce(subtitle,''), coalesce(subline,''),
                            coalesce(verb,''), coalesce(note_field,'')
                       FROM collections WHERE key=?1",
                    [id],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                        ))
                    },
                )
                .unwrap();
            assert_eq!(
                got,
                (
                    t.anchor.to_string(),
                    t.renew_from.to_string(),
                    t.subtitle.to_string(),
                    t.subline.to_string(),
                    t.verb.to_string(),
                    t.note_field.to_string()
                ),
                "{id}：库属性与模板不一致"
            );
        }
    }

    /// SIM 保号与 VPS 出账是两种语义，拆开之后必须真的落在不同的值上——
    /// 这条单测是「别哪天顺手把它们又统一了」的封口。
    #[test]
    fn keepalive_and_fixed_billing_are_different_templates() {
        assert_eq!(template("sims").unwrap().renew_from, "today");
        assert_eq!(template("vps").unwrap().renew_from, "schedule");
        assert_eq!(template("subs").unwrap().renew_from, "schedule");
        // 空白模板跟着默认走：多数周期账单都有固定账单日
        assert_eq!(template("blank").unwrap().renew_from, "schedule");
    }

    /// 第一项必须是空白模板——前端的模板选择器默认选它。
    #[test]
    fn the_first_template_is_the_blank_one() {
        assert_eq!(TEMPLATES[0].id, "blank");
        assert!(TEMPLATES[0].extra.is_empty());
    }

    /// `cycle='days'` 缺天数就算不出到期日、周期还显示成 "Every 0 days"，规则的权威在
    /// 写入口不在浏览器。**只在请求碰了这两个键之一时判**：拿整行去判，库里一个陈年坏值
    /// 就能把这行永久锁死，改别的字段都会被 400。
    #[test]
    fn a_custom_cycle_without_a_day_count_is_refused_at_the_write_entry() {
        let conn = crate::db::fresh_in_memory().unwrap();
        let coll = coll(&conn, "subs");
        assert!(insert_item(&conn, coll, &json!({ "name": "A", "cycle": "days" })).is_err());
        assert!(
            insert_item(&conn, coll, &json!({ "name": "A", "cycle": "days", "cycle_days": 0 }))
                .is_err()
        );
        let id =
            insert_item(&conn, coll, &json!({ "name": "A", "cycle": "days", "cycle_days": 30 }))
                .unwrap();
        // 只改周期不带天数：现值够格就该放行，否则改不了自己的行
        update_item(&conn, id, &json!({ "cycle": "days" })).unwrap();
        assert!(update_item(&conn, id, &json!({ "cycle_days": null })).is_err());

        // 绕开写入口塞一个陈年坏行：不碰这两个键的编辑照样过得去
        conn.execute(
            "INSERT INTO items(collection_id,name,status,cycle) VALUES(?1,'旧行','Active','days')",
            [coll],
        )
        .unwrap();
        let old = conn.last_insert_rowid();
        update_item(&conn, old, &json!({ "notes": "改个备注" })).unwrap();
        assert!(update_item(&conn, old, &json!({ "cycle": "days" })).is_err());
    }

    /// 条目值的形状规则只有一处：同一个坏币种在新建、更新、续费三个写入口都 400，续费的币种与
    /// 条目同一规范化（台账记下就改不了）。
    #[test]
    fn every_item_write_entry_refuses_the_same_bad_currency() {
        let conn = fresh();
        let subs = coll(&conn, "subs");
        let id = insert_item(&conn, subs, &json!({ "name": "A" })).unwrap();
        assert!(insert_item(&conn, subs, &json!({ "name": "A", "currency": "人民币" })).is_err());
        assert!(update_item(&conn, id, &json!({ "currency": "人民币" })).is_err());
        assert!(renew_item(&conn, id, &json!({ "currency": "人民币" })).is_err());
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM renewal_ledger", []), 0, "被拒的续费不该记账");
        renew_item(&conn, id, &json!({ "currency": " usd " })).unwrap();
        assert_eq!(one::<String>(&conn, "SELECT currency FROM renewal_ledger", []), "USD");
    }

    /// 周期是 engine 的封闭集：集外的值落库后到期日算不出、续费只记账不推日期。拒收并列出可选值；
    /// 大小写不同的认下来，清空照旧。
    #[test]
    fn a_cycle_outside_the_engine_set_is_refused_with_the_choices() {
        let conn = fresh();
        let subs = coll(&conn, "subs");
        let err = insert_item(&conn, subs, &json!({ "name": "A", "cycle": "yearly" })).unwrap_err().to_string();
        assert!(err.contains("monthly") && err.contains("lifetime"), "{err}");
        let id = insert_item(&conn, subs, &json!({ "name": "A", "cycle": "Annual" })).unwrap();
        let cycle = |id: i64| -> Option<String> {
            conn.query_row("SELECT cycle FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(cycle(id).as_deref(), Some("annual"));
        assert!(update_item(&conn, id, &json!({ "cycle": "fortnightly" })).is_err());
        update_item(&conn, id, &json!({ "cycle": "" })).unwrap();
        assert_eq!(cycle(id), None);
    }

    /// 状态只在大小写不同、且恰好对上词表里一个值时规范成词表写法；对不上的原样落库（首页点名）。
    #[test]
    fn a_status_is_respelled_only_when_it_matches_exactly_one_vocabulary_value() {
        let conn = fresh();
        let subs = coll(&conn, "subs");
        let st = |id: i64| -> String {
            conn.query_row("SELECT status FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        let a = insert_item(&conn, subs, &json!({ "name": "A", "status": "active" })).unwrap();
        assert_eq!(st(a), "Active");
        let t = insert_item(&conn, subs, &json!({ "name": "T", "status": "Trial" })).unwrap();
        assert_eq!(st(t), "Trial");
        update_item(&conn, t, &json!({ "status": "ENDING" })).unwrap();
        assert_eq!(st(t), "Ending");

        let vocab: String =
            conn.query_row("SELECT options FROM fields WHERE tbl='subs' AND key='status'", [], |r| r.get(0)).unwrap();
        let mut v: Vec<Value> = serde_json::from_str(&vocab).unwrap();
        v.push(json!({ "v": "ACTIVE" }));
        conn.execute(
            "UPDATE fields SET options=?1 WHERE tbl='subs' AND key='status'",
            [serde_json::to_string(&v).unwrap()],
        )
        .unwrap();
        update_item(&conn, t, &json!({ "status": "active" })).unwrap();
        assert_eq!(st(t), "active", "两个候选时不猜");
    }

    /// 日期年份限 1..=9999（chrono 的 `%Y` 吃带符号与五位年，ICS 随之写出 9 位 DTSTART）。两个日期
    /// 真列不论注册与否都按日期判：锚点另一侧那列不在注册表里，从前整条跳过校验。
    #[test]
    fn dates_have_four_digit_years_and_both_date_columns_are_always_checked() {
        for bad_one in ["+12345-01-01", "0000-01-01", "-0001-01-01"] {
            assert!(normalize_shaped("date", bad_one).is_err(), "{bad_one} 不该放行");
        }
        assert_eq!(normalize_shaped("date", "0001-01-01").unwrap(), "0001-01-01");
        let conn = fresh();
        let subs = coll(&conn, "subs");
        assert!(insert_item(&conn, subs, &json!({ "name": "A", "last_renewed": "去年" })).is_err());
        let id = insert_item(&conn, subs, &json!({ "name": "A", "last_renewed": "2026-8-5" })).unwrap();
        assert_eq!(one::<String>(&conn, "SELECT last_renewed FROM items WHERE id=?1", [id]), "2026-08-05");
    }

    /// extra 的值按注册表的类型判：有形状的要是文本并规范化，数字列要是数，单选是文本，多选收文本或
    /// 文本数组（呈现可互换）。与这一行现值相同的键不判：extra 整份往返，陈年坏值否则会让这行的
    /// 任何编辑都 400。
    #[test]
    fn extra_values_follow_their_column_type_but_untouched_old_values_pass() {
        let conn = fresh();
        let (sims, vps) = (coll(&conn, "sims"), coll(&conn, "vps"));
        let refused = [
            (sims, json!({ "phone_number": 4_471_234 })),
            (vps, json!({ "ram_gb": "4" })),
            (vps, json!({ "locations": ["东京", 3] })),
            (vps, json!({ "purpose": ["建站"] })),
        ];
        for (c, extra) in refused {
            assert!(insert_item(&conn, c, &json!({ "name": "X", "extra": extra })).is_err(), "{extra}");
        }
        let id = insert_item(&conn, vps, &json!({ "name": "V", "extra": {
            "ram_gb": 4, "locations": ["东京"], "routes": "CN2, 9929", "purpose": "建站", "cores": null,
        } }))
        .unwrap();

        conn.execute(r#"UPDATE items SET extra='{"ram_gb":"四","locations":["东京"]}' WHERE id=?1"#, [id]).unwrap();
        update_item(&conn, id, &json!({ "extra": { "ram_gb": "四", "locations": ["大阪"] } })).unwrap();
        assert!(update_item(&conn, id, &json!({ "extra": { "ram_gb": "五" } })).is_err(), "改了的值照判");

        let s = insert_item(&conn, sims, &json!({ "name": "S" })).unwrap();
        conn.execute(r#"UPDATE items SET extra='{"phone_number":"打客服"}' WHERE id=?1"#, [s]).unwrap();
        update_item(&conn, s, &json!({ "extra": { "phone_number": "打客服", "forms": ["eSIM"] } })).unwrap();
    }

    /// 模板落表的字段类型没有任何一道运行时检查（`seed_fields` 原样插进 fields 表）。
    /// `FTYPES` 是「新建列」能建的那些，模板另外用得起 `tpl`（只读、由模板串算出）；
    /// 类型写错了列只会哑在那儿——渲染退化成文本、筛选与就地编辑全不认。
    #[test]
    fn template_fields_only_use_types_the_system_knows() {
        for t in TEMPLATES {
            for f in t.extra {
                assert!(
                    crate::fields::FTYPES.contains(&f.ftype) || f.ftype == "tpl",
                    "模板 {} 的字段 {} 用了没人接的类型 {}",
                    t.id,
                    f.key,
                    f.ftype
                );
            }
        }
    }

    /// 电话号码只拦真正的垃圾，不拦"位数偏少"——`+44` 这类残缺值是既有数据，
    /// 在写入口 400 掉等于让人打不开自己的旧条目；位数少由界面标出来提醒。
    #[test]
    fn tel_is_normalised_but_short_numbers_still_get_through() {
        assert_eq!(normalize_shaped("tel", "  +1 424   4329266 ").unwrap(), "+1 424 4329266");
        assert_eq!(normalize_shaped("tel", "+61 0425 418 250").unwrap(), "+61 0425 418 250");
        // 存量里就有的残缺值：放行，不是错误
        assert_eq!(normalize_shaped("tel", "+44").unwrap(), "+44");
        assert_eq!(normalize_shaped("tel", "").unwrap(), "");
        assert_eq!(normalize_shaped("tel", "(020) 7946-0958").unwrap(), "(020) 7946-0958");
        // 一个数字都没有 / 混进不该有的字符：拦下
        assert!(normalize_shaped("tel", "打客服").is_err());
        assert!(normalize_shaped("tel", "+++").is_err());
        assert!(normalize_shaped("tel", "+44 12ab").is_err());
        // 折叠先于白名单：从聊天工具/备忘录粘来的号码常带全角空格，白名单里的空格
        // 是 ASCII 的，次序反了就会把「该折叠的输入」400 掉（报错还几乎读不出来）
        assert_eq!(
            normalize_shaped("tel", "+81　90　1234　5678").unwrap(),
            "+81 90 1234 5678"
        );
        assert_eq!(normalize_shaped("tel", "\u{3000}+44\u{3000}").unwrap(), "+44");
        assert_eq!(normalize_shaped("tel", "+1\t424\n4329266").unwrap(), "+1 424 4329266");
    }

    /// 从通讯录、输入法、网页粘来的真号码：全角数字与符号、点号与 en dash 分隔、夹带的
    /// 方向符与零宽字符（后者 400 时报错里那个字符看不见）。都折成白名单里的写法再判。
    #[test]
    fn pasted_phone_numbers_keep_working() {
        assert_eq!(normalize_shaped("tel", "020.7946.0958").unwrap(), "020 7946 0958");
        assert_eq!(normalize_shaped("tel", "+1 424\u{2013}432\u{2013}9266").unwrap(), "+1 424 432 9266");
        assert_eq!(normalize_shaped("tel", "＋８６ １３８ ００００ ００００").unwrap(), "+86 138 0000 0000");
        assert_eq!(normalize_shaped("tel", "（０２０）７９４６－０９５８").unwrap(), "(020)7946-0958");
        assert_eq!(normalize_shaped("tel", "\u{202A}+44 20 7946 0958\u{202C}").unwrap(), "+44 20 7946 0958");
        assert_eq!(normalize_shaped("tel", "\u{2066}+44\u{200B}20\u{FEFF}\u{2069}").unwrap(), "+4420");
        assert!(normalize_shaped("tel", "\u{200B}").is_err(), "只剩看不见的字符，等于没填数字");
        assert!(normalize_shaped("tel", "+44 12ab").is_err());
    }


    #[test]
    fn url_and_email_shapes_are_normalised() {
        let n = |t, v| normalize_shaped(t, v);
        // 没写协议就补 https://：没有协议的串在 <a href> 里会被当成相对路径
        assert_eq!(n("url", "netflix.com").unwrap(), "https://netflix.com");
        assert_eq!(n("url", " http://a.example.com/x?y=1 ").unwrap(), "http://a.example.com/x?y=1");
        assert!(n("url", "ftp://a.com").is_err());
        assert!(n("url", "没有域名").is_err());
        assert!(n("url", "https://a.com b.com").is_err());
        // 协议按 RFC 3986 不分大小写：粘自旧文档的 HTTPS:// 在浏览器里能开，这里也得认
        assert_eq!(n("url", "HTTPS://Example.com/A").unwrap(), "https://Example.com/A");
        assert_eq!(n("url", "Http://a.com").unwrap(), "http://a.com");
        // 域名大小写不敏感统一小写；用户名部分按规范敏感，原样保留
        assert_eq!(n("email", " Me.You+tag@Example.COM ").unwrap(), "Me.You+tag@example.com");
        assert!(n("email", "no-at-sign").is_err());
        assert!(n("email", "a@b").is_err());          // 域名里没有点
        assert!(n("email", "a@@b.com").is_err());
        assert!(n("email", "a b@c.com").is_err());
        assert_eq!(n("email", "").unwrap(), "");
        // 域名提取：显示与取图标都用它
        assert_eq!(url_host("https://WWW.Example.com/a?b").as_deref(), Some("www.example.com"));
        assert_eq!(url_host("no-dot"), None);
    }

    /// 解析结果这一关：**光看字面拦不住"公共域名指向 127.0.0.1"**（localtest.me
    /// 就是现成例子，不需要 DNS 重绑定），发请求前要把解析出来的地址也验一遍。
    #[test]
    fn resolved_addresses_are_checked_too() {
        // 一个公共域名解析到回环 —— 字面那关它是过的，这关必须拦下
        assert!(!resolved_ips_ok(&[ip("127.0.0.1")]));
        // 多条 A 记录里只要有一条指向内网就整体拒（DNS 轮询可以让你只中一次）
        assert!(!resolved_ips_ok(&[ip("1.1.1.1"), ip("10.0.0.5")]));
        // 解析不出地址同样按拒绝算，别让空结果一路放行
        assert!(!resolved_ips_ok(&[]));
        assert!(resolved_ips_ok(&[ip("1.1.1.1"), ip("8.8.4.4")]));
        // IPv4 映射的 IPv6：::ffff:127.0.0.1 得按里面那个 v4 判，否则整段漏过
        assert!(!public_ip_ok(&ip("::ffff:127.0.0.1")));
        assert!(!public_ip_ok(&ip("::ffff:10.0.0.1")));
        assert!(public_ip_ok(&ip("::ffff:1.1.1.1")));
        // 运营商级 NAT / Tailscale 那一段
        assert!(!public_ip_ok(&ip("100.64.0.1")));
        assert!(!public_ip_ok(&ip("100.127.255.255")));
        assert!(public_ip_ok(&ip("100.63.255.255")));
        assert!(public_ip_ok(&ip("100.128.0.1")));
    }

    /// NAT64 网关会把 `64:ff9b::a9fe:a9fe` 翻成 169.254.169.254（云 metadata），
    /// 而它既非回环、ULA 也非链路本地——不抽出嵌着的 IPv4 再判，v6 分支直接放行。
    #[test]
    fn nat64_addresses_are_judged_by_the_embedded_ipv4() {
        // RFC 6052 熟知前缀 64:ff9b::/96：只有 /96 一种布局
        assert!(!public_ip_ok(&ip("64:ff9b::a9fe:a9fe")));
        assert!(!public_ip_ok(&ip("64:ff9b::7f00:1")));
        assert!(public_ip_ok(&ip("64:ff9b::1.1.1.1")));
        // RFC 8215 本地用前缀 64:ff9b:1::/48：部署时前缀可长到 /96，中间 48 位随意
        assert!(!public_ip_ok(&ip("64:ff9b:1::10.0.0.5")));
        assert!(!public_ip_ok(&ip("64:ff9b:1:abcd::10.0.0.5")));
        assert!(public_ip_ok(&ip("64:ff9b:1:abcd::1.1.1.1")));
        // /64 布局嵌着 10.0.0.5：只按 /96 读会得到 5.0.0.0 而放行，每种成形布局都得过
        assert!(!public_ip_ok(&ip("64:ff9b:1:0:a:0:500:0")));
        // 前缀外的 v6 不受影响
        assert!(public_ip_ok(&ip("64:ff9c::1")));
    }

    #[test]
    fn fetching_icons_refuses_to_touch_the_local_network() {
        for bad in [
            "127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "172.16.0.5",
            "169.254.169.254", "0.0.0.0", "[::1]", "[fe80::1]", "[fd00::1]", "nas.local", "box.localhost",
            // 主机名不分大小写，后缀比较也不能分——否则 FOO.LOCAL 字面关直接放过
            "NAS.LOCAL", "Box.LocalHost", "LOCALHOST",
        ] {
            assert!(!public_host_ok(bad), "本该拦下 {bad}");
        }
        for ok in ["netflix.com", "www.example.co.uk", "1.1.1.1", "8.8.8.8", "[2606:4700:4700::1111]"] {
            assert!(public_host_ok(ok), "本该放行 {ok}");
        }
    }


    /// 取图标那条路按字节认格式，不从 URL 后缀猜：`/favicon.ico` 实际返回 PNG 字节
    /// 是极常见的部署，按后缀猜会让一张完整可用的图标过不了魔数校验被丢掉。
    #[test]
    fn image_format_is_sniffed_from_the_bytes() {
        assert_eq!(sniff_image_ext(b"\x89PNG\r\n\x1a\n rest"), Some("png"));
        assert_eq!(sniff_image_ext(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]), Some("jpg"));
        assert_eq!(sniff_image_ext(b"GIF89a...."), Some("gif"));
        assert_eq!(sniff_image_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_image_ext(&[0x00, 0x00, 0x01, 0x00, 0x01]), Some("ico"));
        assert_eq!(sniff_image_ext(b"<svg xmlns='...'></svg>"), Some("svg"));
        // 放行的集合一点没放宽：不是图片就是不是
        assert_eq!(sniff_image_ext(b"<!DOCTYPE html><html>"), None);
        assert_eq!(sniff_image_ext(b""), None);
        assert_eq!(sniff_image_ext(b"MZ\x90\0"), None);
    }

    /// 页面里随便一个多字节字符都会让按字节切片的解析当场 panic，把请求线程带走。
    #[test]
    fn icon_discovery_survives_multibyte_pages() {
        let html = "𝔽 数学粗体夹在最前面 <link rel=\"icon\" href=\"/a.png\">";
        assert_eq!(icon_links_in(html, "https", "x.com"), vec!["/a.png".to_string()]);
        // 截断也按字符：200k 个汉字之后才出现的标签取不到，但绝不能 panic
        let long = "汉".repeat(300_000) + "<link rel=\"icon\" href=\"/late.png\">";
        assert!(icon_links_in(&long, "https", "x.com").is_empty());
    }

    #[test]
    fn icon_discovery_picks_only_real_icon_links() {
        let h = |s: &str| icon_links_in(s, "https", "x.com");
        assert_eq!(h(r#"<link rel="shortcut icon" href="/f.ico">"#), vec!["/f.ico"]);
        assert_eq!(h(r"<link rel='apple-touch-icon' href='/t.png'>"), vec!["/t.png"]);
        assert_eq!(h(r#"<link rel="icon" href="//x.com/cdn.png">"#), vec!["https://x.com/cdn.png"]);
        // 协议相对地址跟条目自己那个网址的协议走，不一律拼 https
        assert_eq!(
            icon_links_in(r#"<link rel="icon" href="//x.com/c.png">"#, "http", "x.com"),
            vec!["http://x.com/c.png"]
        );
        // rel 不是图标的不要，哪怕 href 里带 icon 字样
        assert!(h(r#"<link rel="stylesheet" href="/icon-theme.css">"#).is_empty());
        // 内联图与跨站图标不要：跨站就超出了"只连你订阅的那个站"
        assert!(h(r#"<link rel="icon" href="data:image/png;base64,AAA">"#).is_empty());
        assert!(h(r#"<link rel="icon" href="https://cdn.other.com/f.png">"#).is_empty());
        // 同站绝对地址可以
        assert_eq!(h(r#"<link rel="icon" href="https://x.com/f.png">"#), vec!["https://x.com/f.png"]);
        assert!(h("<p>没有 link 标签</p>").is_empty());
    }

    fn ip(s: &str) -> std::net::IpAddr {
        s.parse().unwrap()
    }

    fn fresh() -> Connection {
        crate::db::fresh_in_memory().unwrap()
    }

    fn coll(conn: &Connection, key: &str) -> i64 {
        coll_id(conn, key).unwrap()
    }

    /// 新库键越过一切"曾经用过"的编号：现存的库、台账与通知日志里的 kind 都算。
    /// 拿 rowid 派生的话，删掉的库会把 kind 连同旧账一起留给下一个新库。
    #[test]
    fn next_collection_key_skips_every_number_ever_used() {
        let conn = fresh();
        assert_eq!(next_coll_key(&conn).unwrap(), "k1");
        conn.execute("INSERT INTO collections(key,name,pos) VALUES('k5','x',9)", []).unwrap();
        assert_eq!(next_coll_key(&conn).unwrap(), "k6");
        conn.execute("INSERT INTO renewal_ledger(kind,item_id,renewed_at) VALUES('k9',1,'2026-01-01')", []).unwrap();
        assert_eq!(next_coll_key(&conn).unwrap(), "k10");
        conn.execute(
            "INSERT INTO notification_log(kind,item_id,channel,threshold_days,due_date,ok)
             VALUES('k12',1,'telegram',7,'2026-01-01',1)",
            [],
        )
        .unwrap();
        assert_eq!(next_coll_key(&conn).unwrap(), "k13");
    }

    /// 首页与到期时间线靠这份清单显示库名与动作说法：预置三库按 pos 序、每行带齐属性。
    #[test]
    fn collections_lists_the_builtin_three_in_position_order() {
        let rows = collections(&fresh()).unwrap();
        let keys: Vec<&str> = rows.iter().map(|r| r["key"].as_str().unwrap()).collect();
        assert_eq!(keys, ["subs", "sims", "vps"]);
        for r in &rows {
            assert!(r["builtin"] == json!(true) && r["id"].is_i64() && r["pos"].is_i64(), "{r}");
            assert!(ANCHORS.contains(&r["due_anchor"].as_str().unwrap()), "{r}");
            assert!(RENEW_FROMS.contains(&r["renew_from"].as_str().unwrap()), "{r}");
        }
    }

    /// 模板表的规矩：id 唯一非空、选择器要显示的 label 与 desc 非空；域字段键唯一、键与名非空、
    /// 不撞通用字段；带预置选项的必须是词表列（只给封闭词表预置选项）；subline / subtitle /
    /// `note_field` 指向的字段要真在模板里。声明的调整（改名、上不上表）落表后要一字不差。
    #[test]
    fn template_declarations_are_coherent_and_land_as_declared() {
        let conn = fresh();
        let mut ids = std::collections::HashSet::new();
        for t in TEMPLATES {
            assert!(!t.id.is_empty() && ids.insert(t.id), "模板 id 重复或为空：{}", t.id);
            assert!(!t.label.is_empty() && !t.desc.is_empty(), "{}：选择器要显示 label 与 desc", t.id);
            assert!(ANCHORS.contains(&t.anchor) && RENEW_FROMS.contains(&t.renew_from), "{}", t.id);
            let tbl = format!("chk_{}", t.id);
            seed_fields(&conn, &tbl, t.anchor, Some(t)).unwrap();
            let generic: Vec<String> = {
                let mut st = conn
                    .prepare("SELECT key FROM fields WHERE tbl=?1 AND builtin=1")
                    .unwrap();
                st.query_map([&tbl], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
            };
            for (k, name, shown) in t.base {
                assert!(generic.iter().any(|g| g == k), "{}：base 调整了这个到期模型不会播下的字段 {k}", t.id);
                let (got_name, got_shown): (String, i64) = conn
                    .query_row("SELECT name, shown FROM fields WHERE tbl=?1 AND key=?2", params![tbl, k], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .unwrap();
                if !name.is_empty() {
                    assert_eq!(got_name, *name, "{}：{k} 的显示名没落表", t.id);
                }
                assert_eq!(got_shown, *shown, "{}：{k} 的上表设置没落表", t.id);
            }
            let mut keys = std::collections::HashSet::new();
            for f in t.extra {
                assert!(!f.key.is_empty() && !f.name.is_empty(), "{}：域字段键与名不能为空", t.id);
                assert!(keys.insert(f.key) && !generic.iter().any(|g| g == f.key), "{}：域字段键 {} 重复或撞上通用字段", t.id, f.key);
                assert!(f.options.is_empty() || matches!(f.ftype, "sel" | "multi"), "{}：{} 不是词表列却带预置选项", t.id, f.key);
                let (name, ftype, shown, builtin): (String, String, i64, i64) = conn
                    .query_row(
                        "SELECT name, ftype, shown, builtin FROM fields WHERE tbl=?1 AND key=?2",
                        params![tbl, f.key],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )
                    .unwrap();
                assert_eq!((name.as_str(), ftype.as_str(), shown, builtin), (f.name, f.ftype, f.shown, 0), "{}：{}", t.id, f.key);
            }
            for (what, k) in [("subline", t.subline), ("subtitle", t.subtitle), ("note_field", t.note_field)] {
                assert!(k.is_empty() || t.extra.iter().any(|f| f.key == k), "{}：{what} 指向不存在的字段 {k}", t.id);
            }
        }
    }

    /// 空白模板播通用四值状态词表，续费三库多出 Deferred（比价目录）与 Unused（未启用）；
    /// 语义标记随词表一起落：Active 三项全开、Ending 只上时间线、其余全关。
    #[test]
    fn seeded_status_vocabularies_carry_their_semantics() {
        let conn = fresh();
        let vocab = |tpl: &str, anchor: &str| -> Vec<Value> {
            let tbl = format!("v_{tpl}");
            seed_fields(&conn, &tbl, anchor, template(tpl)).unwrap();
            let options: String = one(&conn, "SELECT options FROM fields WHERE tbl=?1 AND key='status'", [&tbl]);
            serde_json::from_str(&options).unwrap()
        };
        let vals = |opts: &[Value]| opts.iter().map(|o| o["v"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let blank = vocab("blank", "last");
        assert_eq!(vals(&blank), ["Active", "Planned", "Ending", "Ended"]);
        let subs = vocab("subs", "next");
        assert_eq!(vals(&subs), ["Active", "Planned", "Deferred", "Unused", "Ending", "Ended"]);
        let sem = |opts: &[Value], v: &str| {
            let o = opts.iter().find(|o| o["v"] == v).unwrap();
            (o["spend"] == 1, o["alert"] == 1, o["timeline"] == 1)
        };
        for opts in [&blank, &subs] {
            assert_eq!(sem(opts, "Active"), (true, true, true));
            assert_eq!(sem(opts, "Ending"), (false, false, true));
            assert_eq!(sem(opts, "Planned"), (false, false, false));
        }
        assert_eq!(sem(&subs, "Deferred"), (false, false, false));
        assert_eq!(sem(&subs, "Unused"), (false, false, false));
    }

    /// 子行只有两层且不跨库：自己当自己的父行、跨库、挂到已是子行的行下（三层）、
    /// 已有子行的条目再挂到别人下——四条各拦一次；父行不存在按 404 级错误。
    #[test]
    fn parent_links_are_limited_to_two_levels_within_one_collection() {
        let conn = fresh();
        let (subs, sims) = (coll(&conn, "subs"), coll(&conn, "sims"));
        let svc = insert_item(&conn, subs, &json!({ "name": "服务" })).unwrap();
        let tier = insert_item(&conn, subs, &json!({ "name": "档位", "parent_id": svc })).unwrap();
        assert!(insert_item(&conn, subs, &json!({ "name": "孙", "parent_id": tier })).is_err(), "三层");
        assert!(insert_item(&conn, sims, &json!({ "name": "跨库", "parent_id": svc })).is_err(), "跨库");
        assert!(insert_item(&conn, subs, &json!({ "name": "野父", "parent_id": 9999 })).is_err(), "父行不存在");
        assert!(update_item(&conn, svc, &json!({ "parent_id": svc })).is_err(), "自引用");
        let other = insert_item(&conn, subs, &json!({ "name": "别人" })).unwrap();
        assert!(update_item(&conn, svc, &json!({ "parent_id": other })).is_err(), "已有子行的不能再当子行");
        // 换到另一个顶层父行、或回到顶层，都是合法的两层
        update_item(&conn, tier, &json!({ "parent_id": other })).unwrap();
        update_item(&conn, tier, &json!({ "parent_id": null })).unwrap();
        assert_eq!(one::<Option<i64>>(&conn, "SELECT parent_id FROM items WHERE id=?1", [tier]), None);
    }

    /// 一行数值列存成了别的类型（SQLite 工具里把价格填成 `12,50`、天数填成小数）：概览、
    /// 条目列表、续费都照常，坏行进点名清单；只改备注的 PATCH 不碰那个读不出的原值
    #[test]
    fn a_row_with_a_mistyped_number_is_named_instead_of_failing_every_read() {
        let conn = fresh();
        let due = (engine::today() + chrono::Days::new(5)).to_string();
        let ok = insert_item(&conn, coll(&conn, "subs"), &json!({ "name": "好", "status": "Active", "price": 5, "currency": "USD", "cycle": "monthly", "next_renewal": due })).unwrap();
        let price = insert_item(&conn, coll(&conn, "subs"), &json!({ "name": "坏价", "status": "Active", "currency": "USD", "cycle": "monthly", "next_renewal": due })).unwrap();
        let days = insert_item(&conn, coll(&conn, "sims"), &json!({ "name": "坏天数", "status": "Active", "cycle": "days", "cycle_days": 30, "last_renewed": due })).unwrap();
        conn.execute("UPDATE items SET price='12,50' WHERE id=?1", [price]).unwrap();
        conn.execute("UPDATE items SET cycle_days=1.5 WHERE id=?1", [days]).unwrap();

        let ups = engine::upcoming(&conn).unwrap();
        assert!(ups.iter().any(|u| u["id"] == ok) && ups.iter().any(|u| u["id"] == price));
        let gaps = engine::uncounted(&conn).unwrap();
        assert!(gaps.iter().any(|g| g["id"] == price && g["missing"] == "金额"), "{gaps:?}");
        let und = engine::undated(&conn).unwrap();
        assert!(und.iter().any(|u| u["id"] == days && u["missing"] == "周期天数"), "{und:?}");
        assert!(items_of(&conn, "subs").unwrap().iter().any(|r| r["id"] == price && r["price"].is_null()));
        renew_item(&conn, price, &json!({})).unwrap();

        update_item(&conn, price, &json!({ "notes": "只改备注" })).unwrap();
        assert_eq!(one::<String>(&conn, "SELECT typeof(price)||':'||price FROM items WHERE id=?1", [price]), "text:12,50");
    }

    /// 父行规则只判这次请求带来的 `parent_id`：库里一条存量三层链（旧界面造得出来）
    /// 不能让链上的行连备注都改不了；请求真带了坏父行仍然拦
    #[test]
    fn a_stale_bad_parent_link_does_not_lock_the_row() {
        let conn = fresh();
        let subs = coll(&conn, "subs");
        let svc = insert_item(&conn, subs, &json!({ "name": "服务" })).unwrap();
        let tier = insert_item(&conn, subs, &json!({ "name": "档位", "parent_id": svc })).unwrap();
        let kid = insert_item(&conn, subs, &json!({ "name": "孙" })).unwrap();
        conn.execute("UPDATE items SET parent_id=?1 WHERE id=?2", [tier, kid]).unwrap();
        update_item(&conn, kid, &json!({ "notes": "只改备注" })).unwrap();
        update_item(&conn, tier, &json!({ "notes": "只改备注" })).unwrap();
        assert_eq!(one::<Option<i64>>(&conn, "SELECT parent_id FROM items WHERE id=?1", [kid]), Some(tier), "存量链接原样保留");
        assert!(update_item(&conn, kid, &json!({ "parent_id": tier })).is_err(), "请求带来的三层仍拦");
    }

    /// 批量端点的 ids：整数数组照收，掺了非整数、空数组、没这个键都整体拒——
    /// 静默滤掉等于「说删 5 个、实际删 3 个」还不吭声。
    #[test]
    fn id_lists_are_all_or_nothing() {
        assert_eq!(id_list(&json!({ "ids": [3, 1, 2] })).unwrap(), vec![3, 1, 2]);
        for bad_body in [json!({ "ids": [1, "2"] }), json!({ "ids": [] }), json!({}), json!({ "ids": "1,2" }), json!({ "ids": [1.5] })] {
            assert!(id_list(&bad_body).is_err(), "{bad_body}");
        }
    }

    /// 一个库的条目带上按它的到期模型算出的 `due` 与 `days_left`：`next` 直接读下次续费日，
    /// `last` 从上次续费按周期推；算不出的给 null 而不是丢行；库不存在是错误。
    #[test]
    fn items_carry_due_and_days_left_by_the_collection_anchor() {
        let conn = fresh();
        let today = engine::today();
        let (subs, sims) = (coll(&conn, "subs"), coll(&conn, "sims"));
        let in3 = (today + chrono::Days::new(3)).to_string();
        insert_item(&conn, subs, &json!({ "name": "A", "next_renewal": in3 })).unwrap();
        let ago10 = (today - chrono::Days::new(10)).to_string();
        insert_item(&conn, sims, &json!({ "name": "S", "cycle": "days", "cycle_days": 30, "last_renewed": ago10 })).unwrap();
        insert_item(&conn, sims, &json!({ "name": "无日期" })).unwrap();
        let find = |rows: &[Value], name: &str| rows.iter().find(|r| r["name"] == name).cloned().unwrap();
        let a = find(&items_of(&conn, "subs").unwrap(), "A");
        assert_eq!((a["due"].clone(), a["days_left"].clone()), (json!(in3), json!(3)));
        let sims_rows = items_of(&conn, "sims").unwrap();
        let s = find(&sims_rows, "S");
        assert_eq!((s["due"].clone(), s["days_left"].clone()), (json!((today + chrono::Days::new(20)).to_string()), json!(20)));
        let none = find(&sims_rows, "无日期");
        assert!(none["due"].is_null() && none["days_left"].is_null(), "{none}");
        assert!(items_of(&conn, "nope").is_err());
    }

    /// 删条目连它的图标文件一起清；行不存在是幂等成功。
    #[test]
    fn deleting_an_item_removes_its_row_and_its_logo_file() {
        let dir = tempfile::tempdir().unwrap();
        let conn = fresh();
        let app = App::for_tests(Connection::open_in_memory().unwrap(), dir.path());
        let id = insert_item(&conn, coll(&conn, "subs"), &json!({ "name": "有图" })).unwrap();
        let name = set_logo(&app, &conn, id, "png", b"\x89PNG\r\n\x1a\n....").unwrap();
        let file = dir.path().join("logos").join(&name);
        assert!(file.is_file());
        assert_eq!(one::<Option<String>>(&conn, "SELECT logo FROM items WHERE id=?1", [id]), Some(name.clone()));
        delete_item(&app, &conn, id).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM items WHERE id=?1", [id]), 0);
        assert!(!file.exists(), "图标文件成了孤儿");
        delete_item(&app, &conn, id).unwrap();
    }

    /// 续费＝写一笔台账 + 按库的到期模型推日期，响应回 due 让界面如实报"下次到期"。
    /// 台账默认取条目的金额与币种、当场钉进条目名与库名；`last` 锚点 + `today` 起算把上次续费记成今天。
    #[test]
    fn renewing_writes_the_ledger_and_moves_the_anchor_date() {
        let conn = fresh();
        let today = engine::today();
        let subs = coll(&conn, "subs");
        let due = today + chrono::Days::new(10);
        let id = insert_item(
            &conn,
            subs,
            &json!({ "name": "Netflix", "price": 15.5, "currency": "USD", "cycle": "monthly", "next_renewal": due.to_string() }),
        )
        .unwrap();
        let out = renew_item(&conn, id, &json!({ "note": "刷卡" })).unwrap();
        let next = engine::advance(due, "monthly", None).unwrap().to_string();
        assert_eq!(out, json!({ "next_renewal": next, "due": next }));
        assert_eq!(one::<String>(&conn, "SELECT next_renewal FROM items WHERE id=?1", [id]), next);
        let ledger: (String, Option<f64>, String, String, String, String) = conn
            .query_row(
                "SELECT renewed_at, amount, currency, note, item_name, coll_name FROM renewal_ledger WHERE kind='subs' AND item_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        let coll_name: String = one(&conn, "SELECT name FROM collections WHERE key='subs'", []);
        assert_eq!(ledger, (today.to_string(), Some(15.5), "USD".into(), "刷卡".into(), "Netflix".into(), coll_name));
        // 传了金额就记传的
        renew_item(&conn, id, &json!({ "amount": 12 })).unwrap();
        assert_eq!(one::<Option<f64>>(&conn, "SELECT amount FROM renewal_ledger WHERE item_id=?1 ORDER BY id DESC LIMIT 1", [id]), Some(12.0));

        // SIM 保号：上次续费记成今天，窗口从今天重算
        let sim = insert_item(
            &conn,
            coll(&conn, "sims"),
            &json!({ "name": "SIM", "cycle": "days", "cycle_days": 30, "last_renewed": "2026-01-01" }),
        )
        .unwrap();
        let out = renew_item(&conn, sim, &json!({})).unwrap();
        assert_eq!(out["last_renewed"], json!(today.to_string()));
        assert_eq!(out["due"], json!((today + chrono::Days::new(30)).to_string()));
        assert!(renew_item(&conn, 9999, &json!({})).is_err());
    }

    /// 库路由 + 字段路由共用一个库，好在建库 / 改库之后回读字段注册表。
    fn routed(conn: Connection, data_dir: &std::path::Path) -> Router {
        router().merge(crate::fields::router()).with_state(App::for_tests(conn, data_dir))
    }

    /// 只有「没有这一行」才是 404 / 400；表读不出是真故障，要 500 并留 warn，
    /// 报成「条目不存在」的话排障方向全错。逐张表改名弄坏，碰到它的端点一律 500。
    #[tokio::test]
    async fn a_table_that_cannot_be_read_is_a_500_not_a_missing_row() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::for_tests(fresh(), dir.path());
        let r = router().merge(crate::fields::router()).with_state(app.clone());
        let (_, it) = call(&r, "POST", "/api/collections/subs/items", Some(json!({ "name": "A", "url": "https://example.com" }))).await;
        let id = it["id"].as_i64().unwrap();
        let (_, f) = call(&r, "POST", "/api/fields", Some(json!({ "tbl": "subs", "name": "标签", "ftype": "sel" }))).await;
        let (fid, fkey) = (f["id"].as_i64().unwrap(), f["key"].as_str().unwrap().to_string());
        let cid = coll(&app.db.lock().unwrap(), "subs");
        let rename = |from: &str, to: &str| {
            app.db.lock().unwrap().execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}")).unwrap();
        };
        let cases = [
            ("items", vec![
                ("PATCH", format!("/api/items/{id}"), Some(json!({ "note": "x" }))),
                ("POST", format!("/api/items/{id}/renew"), Some(json!({}))),
                ("DELETE", format!("/api/items/{id}/logo"), None),
                ("POST", format!("/api/items/{id}/logo/fetch"), Some(json!({}))),
            ]),
            ("collections", vec![
                ("GET", "/api/collections/subs/items".into(), None),
                ("PUT", format!("/api/collections/{cid}"), Some(json!({ "name": "x" }))),
                ("DELETE", format!("/api/collections/{cid}"), None),
                ("POST", "/api/fields".into(), Some(json!({ "tbl": "subs", "name": "x" }))),
            ]),
            ("fields", vec![
                ("PUT", format!("/api/fields/{fid}"), Some(json!({ "name": "标签", "shown": false }))),
                ("PUT", "/api/fields/semantics".into(), Some(json!({ "tbl": "subs", "key": "status", "options": [{ "v": "Active", "spend": true }] }))),
                ("POST", "/api/fields/add_status".into(), Some(json!({ "tbl": "subs", "key": "status", "value": "New" }))),
                ("PUT", "/api/fields/options".into(), Some(json!({ "tbl": "subs", "key": fkey, "options": ["a"] }))),
                ("DELETE", format!("/api/fields/{fid}"), None),
            ]),
        ];
        let mut wrong = Vec::new();
        for (table, reqs) in cases {
            rename(table, "gone");
            for (method, path, body) in reqs {
                let (st, b) = call(&r, method, &path, body).await;
                if st != StatusCode::INTERNAL_SERVER_ERROR {
                    wrong.push(format!("{table} 读不出时 {method} {path} → {st} {b}"));
                }
            }
            if table == "items" {
                let e = set_logo(&app, &app.db.lock().unwrap(), id, "png", b"\x89PNG....").unwrap_err();
                if e.downcast_ref::<crate::api::ClientError>().is_some() {
                    wrong.push(format!("items 读不出时 set_logo → 客户端错误 {e}"));
                }
            }
            rename("gone", table);
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
        // 真没有这一行时照旧是客户端错误
        assert_eq!(call(&r, "PATCH", "/api/items/9999", Some(json!({ "note": "x" }))).await.0, StatusCode::NOT_FOUND);
        assert_eq!(call(&r, "DELETE", "/api/fields/9999", None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(call(&r, "GET", "/api/collections/nope/items", None).await.0, StatusCode::NOT_FOUND);
        let st = call(&r, "PUT", "/api/fields/semantics", Some(json!({ "tbl": "subs", "key": "nope", "options": [] }))).await.0;
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }

    /// 建库：到期模型与续费起算方式只认已知值；键由服务端编；模板值只在请求压根没提这个键时兜底，
    /// 留空的属性落成 null 而不是 ""（空串 verb 会把「续费」回落顶掉）。
    #[tokio::test]
    async fn creating_a_collection_validates_the_model_and_fills_from_the_template() {
        let r = routed(fresh(), std::path::Path::new("."));
        for bad_body in [
            json!({ "name": "x", "due_anchor": "weird" }),
            json!({ "name": "x", "renew_from": "whenever" }),
            json!({ "name": "x", "template": "nope" }),
            json!({ "due_anchor": "next" }),
        ] {
            assert_eq!(call(&r, "POST", "/api/collections", Some(bad_body.clone())).await.0, StatusCode::BAD_REQUEST, "{bad_body}");
        }
        let (st, c) = call(&r, "POST", "/api/collections", Some(json!({ "name": "我的库" }))).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(c["key"], json!("k1"));
        assert_eq!((c["due_anchor"].clone(), c["renew_from"].clone()), (json!("last"), json!("schedule")));
        assert!(c["icon"].is_null() && c["verb"].is_null() && c["subtitle"].is_null(), "{c}");
        let (st, d) = call(&r, "POST", "/api/collections", Some(json!({ "name": "证件", "template": "docs", "icon": "" }))).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!((d["key"].clone(), d["due_anchor"].clone(), d["verb"].clone()), (json!("k2"), json!("next"), json!("换证")));
        assert!(d["icon"].is_null(), "界面清空图标传的 \"\" 不该被模板顶回来：{d}");
    }

    /// 改库：同一套取值校验；换到期模型时把新锚点那侧的日期字段补进注册表，重复切换幂等。
    #[tokio::test]
    async fn updating_a_collection_registers_the_other_anchors_date_field() {
        let r = routed(fresh(), std::path::Path::new("."));
        let (_, c) = call(&r, "POST", "/api/collections", Some(json!({ "name": "我的库" }))).await;
        let (id, key) = (c["id"].as_i64().unwrap(), c["key"].as_str().unwrap().to_string());
        let date_fields = |r: &Router| {
            let (r, key) = (r.clone(), key.clone());
            async move {
                let (_, fields) = call(&r, "GET", "/api/fields", None).await;
                let mut keys: Vec<String> = fields
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|f| f["tbl"] == key && f["ftype"] == "date")
                    .map(|f| f["key"].as_str().unwrap().to_string())
                    .collect();
                keys.sort();
                keys
            }
        };
        assert_eq!(date_fields(&r).await, ["last_renewed"]);
        let path = format!("/api/collections/{id}");
        // 空名与建库同判：当缺席处理会静默留着原名、回 200
        for bad_body in [
            json!({ "due_anchor": "weird" }),
            json!({ "renew_from": "x" }),
            json!({ "name": "" }),
            json!({ "name": "  " }),
            json!({ "name": null }),
        ] {
            assert_eq!(call(&r, "PUT", &path, Some(bad_body.clone())).await.0, StatusCode::BAD_REQUEST, "{bad_body}");
        }
        assert_eq!(call(&r, "PUT", &path, Some(json!({ "due_anchor": "next" }))).await.0, StatusCode::OK);
        assert_eq!(date_fields(&r).await, ["last_renewed", "next_renewal"]);
        assert_eq!(call(&r, "PUT", &path, Some(json!({ "due_anchor": "next" }))).await.0, StatusCode::OK);
        assert_eq!(date_fields(&r).await, ["last_renewed", "next_renewal"]);
        assert_eq!(call(&r, "PUT", "/api/collections/9999", Some(json!({ "name": "x" }))).await.0, StatusCode::NOT_FOUND);
    }

    /// 取图标的整轮截止要管住每一次网络等待，不只在候选之间判：一个候选跟几跳慢速重定向，
    /// 就能把一轮拖到截止的两倍多。本地代理每次应答都慢半秒再 302，截止给 1 s。
    #[tokio::test]
    async fn fetching_a_logo_stops_at_the_deadline_even_mid_redirect() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let _ = sock.read(&mut [0u8; 4096]).await;
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                });
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let app = App::for_tests(fresh(), dir.path());
        let started = std::time::Instant::now();
        let err = grab_logo(&app, 1, &proxy, "http", "1.1.1.1", std::time::Duration::from_secs(1)).await.unwrap_err();
        let took = started.elapsed();
        assert!(took < std::time::Duration::from_millis(1400), "{took:?}：{err:#}");
        assert!(format!("{err:#}").contains("收手"), "{err:#}");
    }

    /// 上传图标：格式白名单、非空且 ≤1 MB、魔数与声明格式一致；换图时删旧文件；
    /// 条目不存在按 404 级错误。清除图标连文件一起清。
    #[test]
    fn logo_uploads_are_checked_and_replace_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let conn = fresh();
        let app = App::for_tests(Connection::open_in_memory().unwrap(), dir.path());
        let id = insert_item(&conn, coll(&conn, "subs"), &json!({ "name": "图" })).unwrap();
        let png = b"\x89PNG\r\n\x1a\n....".to_vec();
        assert!(set_logo(&app, &conn, id, "bmp", &png).is_err(), "不支持的格式");
        assert!(set_logo(&app, &conn, id, "png", b"").is_err(), "空文件");
        assert!(set_logo(&app, &conn, id, "png", b"GIF89a..").is_err(), "内容与声明格式不符");
        let mut big = png.clone();
        big.resize(1_000_001, 0);
        assert!(set_logo(&app, &conn, id, "png", &big).is_err(), "超过 1 MB");
        big.truncate(1_000_000);
        assert!(set_logo(&app, &conn, id, "png", &big).is_ok(), "恰好 1 MB 放行");
        assert!(set_logo(&app, &conn, 9999, "png", &png).is_err(), "条目不存在");

        let first = set_logo(&app, &conn, id, "png", &png).unwrap();
        let logos = dir.path().join("logos");
        assert!(logos.join(&first).is_file());
        // 换一张不同名的（格式不同就不会同名）：旧文件删掉、列指向新文件
        let second = set_logo(&app, &conn, id, "gif", b"GIF89a....").unwrap();
        assert_ne!(first, second);
        assert!(!logos.join(&first).exists(), "旧图标成了孤儿");
        assert!(logos.join(&second).is_file());
        assert_eq!(one::<Option<String>>(&conn, "SELECT logo FROM items WHERE id=?1", [id]), Some(second.clone()));
        clear_logo(&app, &conn, id).unwrap();
        assert_eq!(one::<Option<String>>(&conn, "SELECT logo FROM items WHERE id=?1", [id]), None);
        assert!(!logos.join(&second).exists());
        assert!(clear_logo(&app, &conn, 9999).is_err());
    }

    /// `/logos/{name}`：文件名先过白名单再拼路径，认不得的名字与不存在的文件都是 404；
    /// 类型按扩展名给、带一周缓存与 nosniff；SVG 另加 CSP sandbox（它能带脚本）。
    #[tokio::test]
    async fn logo_files_are_served_by_safe_name_with_the_right_headers() {
        let dir = tempfile::tempdir().unwrap();
        let logos = dir.path().join("logos");
        std::fs::create_dir_all(&logos).unwrap();
        for (name, bytes) in [
            ("a.png", &b"\x89PNG"[..]),
            ("b.webp", b"RIFF"),
            ("c.svg", b"<svg/>"),
            ("d.gif", b"GIF8"),
            ("e.ico", b"\0\0\x01\0"),
            ("f.jpg", b"\xFF\xD8\xFF"),
            ("g.jpeg", b"\xFF\xD8\xFF"),
            ("h.txt", b"not an icon"),
        ] {
            std::fs::write(logos.join(name), bytes).unwrap();
        }
        let r = routed(fresh(), dir.path());
        let get = |p: String| {
            let r = r.clone();
            async move {
                use tower::util::ServiceExt;
                r.oneshot(axum::http::Request::get(p).body(axum::body::Body::empty()).unwrap())
                    .await
                    .unwrap()
            }
        };
        let hdr = |resp: &Response, h: header::HeaderName| resp.headers().get(h).and_then(|v| v.to_str().ok()).map(str::to_string);
        for (name, mime) in [
            ("a.png", "image/png"),
            ("b.webp", "image/webp"),
            ("c.svg", "image/svg+xml"),
            ("d.gif", "image/gif"),
            ("e.ico", "image/x-icon"),
            ("f.jpg", "image/jpeg"),
            ("g.jpeg", "image/jpeg"),
        ] {
            let resp = get(format!("/logos/{name}")).await;
            assert_eq!(resp.status(), StatusCode::OK, "{name}");
            assert_eq!(hdr(&resp, header::CONTENT_TYPE).as_deref(), Some(mime), "{name}");
            assert_eq!(hdr(&resp, header::CACHE_CONTROL).as_deref(), Some("public, max-age=604800"), "{name}");
            assert_eq!(hdr(&resp, header::X_CONTENT_TYPE_OPTIONS).as_deref(), Some("nosniff"), "{name}");
            let csp = hdr(&resp, header::CONTENT_SECURITY_POLICY);
            if name == "c.svg" {
                assert!(csp.as_deref().is_some_and(|c| c.contains("sandbox")), "{name}: {csp:?}");
            } else {
                assert_eq!(csp, None, "{name}");
            }
        }
        // 写入口不会落出别的后缀；真有这样的文件也不替它猜成 jpeg
        for miss in ["/logos/nope.png", "/logos/..%2Fkalends.db", "/logos/%E5%9B%BE.png", "/logos/h.txt"] {
            assert_eq!(get(miss.to_string()).await.status(), StatusCode::NOT_FOUND, "{miss}");
        }
    }

    /// 取图标的入口先看条目有没有网址、再过字面关——内网地址在发任何请求之前就被拒。
    #[tokio::test]
    async fn icon_fetch_refuses_local_targets_before_touching_the_network() {
        let conn = fresh();
        let subs = coll(&conn, "subs");
        let bare = insert_item(&conn, subs, &json!({ "name": "没网址" })).unwrap();
        let local = insert_item(&conn, subs, &json!({ "name": "内网", "url": "http://nas.local/" })).unwrap();
        let r = routed(conn, std::path::Path::new("."));
        let (st, out) = call(&r, "POST", &format!("/api/items/{bare}/logo/fetch"), Some(json!({}))).await;
        assert_eq!((st, out["error"].as_str()), (StatusCode::BAD_REQUEST, Some("这个条目还没有网址")));
        for (id, body) in [(local, json!({})), (bare, json!({ "url": "http://127.0.0.1:8080/x" })), (bare, json!({ "url": "10.0.0.5/favicon.ico" }))] {
            let (st, out) = call(&r, "POST", &format!("/api/items/{id}/logo/fetch"), Some(body.clone())).await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(out["error"], json!("只能从公网站点取图标"), "{body}");
        }
        assert_eq!(call(&r, "POST", "/api/items/9999/logo/fetch", Some(json!({}))).await.0, StatusCode::NOT_FOUND);
    }

    /// 字面关的其余出口：空主机、只有端口、广播地址、RFC 5737 文档段都不是可连的公网目标；
    /// 字面 IP 直接钉住不查 DNS，内网字面量在 `resolve_public` 这一层同样过不去。
    #[tokio::test]
    async fn literal_hosts_are_pinned_without_dns_and_unroutable_ranges_are_refused() {
        use std::net::SocketAddr;
        for no in ["", ":8080", "[]", "[::]"] {
            assert!(!public_host_ok(no), "本该拦下 {no:?}");
        }
        for no in ["255.255.255.255", "192.0.2.1", "198.51.100.7", "203.0.113.9"] {
            assert!(!public_ip_ok(&ip(no)), "本该拦下 {no}");
        }
        assert_eq!(resolve_public("1.1.1.1", 443).await, Some(SocketAddr::new(ip("1.1.1.1"), 443)));
        assert_eq!(resolve_public("[2606:4700:4700::1111]", 80).await, Some(SocketAddr::new(ip("2606:4700:4700::1111"), 80)));
        assert_eq!(resolve_public("10.0.0.5", 443).await, None);
        assert_eq!(resolve_public("[::1]", 443).await, None);
        assert_eq!(resolve_public("nas.local", 443).await, None);
    }

    /// RFC 6052 §2.2 的四种布局各抽一次：/48 与 /56 也要读得出嵌着的 10.0.0.5；
    /// u 字节或后缀不为零的布局不成形，不能拿它的候选去否决一个成形布局里的公网地址。
    #[test]
    fn every_nat64_layout_is_read_and_malformed_layouts_do_not_count() {
        // /48：v4 在字节 6,7,9,10（字节 8 是 u）；/56：v4 在字节 7,9,10,11
        assert!(!public_ip_ok(&ip("64:ff9b:1:a00:0:500::")), "/48 布局里嵌着 10.0.0.5");
        assert!(!public_ip_ok(&ip("64:ff9b:1:a:0:5::")), "/56 布局里嵌着 10.0.0.5");
        // /96 布局里是 1.1.1.1；/48 布局读出来会是 10.0.0.0，但它的后缀不为零、不成形，不作数
        assert!(public_ip_ok(&ip("64:ff9b:1:a00::1.1.1.1")));
    }

    /// 属性扫描按文档的规矩：属性名前要有分界（`hreflang` / `data-rel` 里的 rel 不算）、
    /// `=` 两侧可有空白、值必须带引号；残缺的标签不 panic。
    #[test]
    fn attribute_scanning_respects_boundaries_and_quotes() {
        let h = |s: &str| icon_links_in(s, "https", "x.com");
        assert_eq!(h(r#"<link rel = "icon" href = "/sp.png">"#), vec!["/sp.png"]);
        assert!(h(r#"<link hreflang="icon" href="/h.png">"#).is_empty(), "hreflang 里的 rel 不是属性");
        assert!(h(r#"<link data-rel="icon" href="/d.png">"#).is_empty(), "data-rel 里的 rel 不是属性");
        assert!(h(r#"<link rel=icon href="/u.png">"#).is_empty(), "不带引号的值不认");
        assert!(h(r#"<link rel="icon" href="/x.png>"#).is_empty(), "引号没闭合");
        for broken in ["<link rel", "<link rel=", "<link rel  ", "<link", "<"] {
            assert!(h(broken).is_empty(), "{broken:?}");
        }
        assert_eq!(attr_value("link REL='icon' Href=\"/m.png\"", "href"), Some("/m.png"));
        assert_eq!(attr_value("link rel='icon'", "href"), None);
        // 最多取四条，多的丢掉
        let many = r#"<link rel="icon" href="/n.png">"#.repeat(6);
        assert_eq!(h(&many).len(), 4);
    }

    /// 只读前 `limit` 字节就收手：发现页只看 `<head>`，超出的部分不进内存。
    /// 末两行钉的是出网封顶的规格值：图标 ≤ 2 MB、发现页 ≤ 512 KB。
    #[tokio::test]
    async fn body_head_stops_at_the_limit() {
        let resp = |s: &'static str| reqwest::Response::from(axum::http::Response::new(s));
        assert_eq!(body_head(resp("0123456789"), 4).await, b"0123");
        assert_eq!(body_head(resp("0123456789"), 100).await, b"0123456789");
        assert_eq!(body_head(resp(""), 4).await, b"");
        assert_eq!(ICON_MAX, 2 * 1024 * 1024);
        assert_eq!(PAGE_MAX, 512 * 1024);
    }

    /// 批量删除报真正删掉的条数，不是请求里的 id 个数；整批一个事务。
    #[tokio::test]
    async fn bulk_delete_reports_the_rows_actually_removed() {
        let conn = fresh();
        let subs = coll(&conn, "subs");
        let a = insert_item(&conn, subs, &json!({ "name": "甲" })).unwrap();
        let b = insert_item(&conn, subs, &json!({ "name": "乙" })).unwrap();
        let r = routed(conn, std::path::Path::new("."));
        let (st, out) = call(&r, "POST", "/api/items/bulk_delete", Some(json!({ "ids": [a, b, 9999] }))).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(out["deleted"], json!(2));
        let (_, rows) = call(&r, "GET", "/api/collections/subs/items", None).await;
        assert!(rows.as_array().unwrap().iter().all(|x| x["id"] != a && x["id"] != b));
        assert_eq!(call(&r, "POST", "/api/items/bulk_delete", Some(json!({ "ids": [] }))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(&r, "POST", "/api/items/bulk_delete", Some(json!({ "ids": [1, "2"] }))).await.0, StatusCode::BAD_REQUEST);
    }
}
