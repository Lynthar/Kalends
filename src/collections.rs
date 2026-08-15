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
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::api::{bad, extra_json, extra_str, f, i, missing, s, safe_name, ApiError, R};
use crate::{engine, App};

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
        // 条目更新是 PATCH 不是 PUT：语义就是局部更新（缺席即保持），见 `merge_over`
        .route("/api/items/{id}", patch(items_update).delete(items_delete))
        .route("/api/items/{id}/renew", post(items_renew))
        .route("/api/items/{id}/logo", post(logo_set).delete(logo_clear))
        .route("/api/items/{id}/logo/fetch", post(logo_fetch))
        .route("/logos/{name}", get(logo_file))
}

/* ── 库 ─────────────────────────────────────────────────────────── */

const COLL_COLS: &str =
    "id,key,name,icon,due_anchor,subtitle,subline,verb,note_field,pos,builtin,renew_from";

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
        // 保号窗口本来就从实际充值那天重新计时——三个预置库里只有这个该是 today
        renew_from: "today",
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

/// 新建的库要能直接用：播一套默认字段集，否则表格没有列、详情表单是空的。
/// 到期锚点决定给"下次到期日"还是"上次续费 + 剩余天数"，模板再往上加域字段。
/// 词表按 SQLite `json()` 的形态写成紧凑一行：迁移 0008 播状态词表时用的就是它，
/// 两边要逐字节一致，模板等价单测才对得上（serde_json 会按字母重排键，不能拿来压缩）。
const STATUS_VOCAB: &str = r#"[{"v":"Active","spend":1,"alert":1,"timeline":1},{"v":"Planned","spend":0,"alert":0,"timeline":0},{"v":"Ending","spend":0,"alert":0,"timeline":1},{"v":"Ended","spend":0,"alert":0,"timeline":0}]"#;

/// 三个续费库共用的六值词表：比通用词表多 Deferred（比价目录，记各档位供比较）
/// 与 Unused（未启用），两者都不计支出、不提醒、不上时间线。
const RENEWAL_STATUS_VOCAB: &str = r#"[{"v":"Active","spend":1,"alert":1,"timeline":1},{"v":"Planned","spend":0,"alert":0,"timeline":0},{"v":"Deferred","spend":0,"alert":0,"timeline":0},{"v":"Unused","spend":0,"alert":0,"timeline":0},{"v":"Ending","spend":0,"alert":0,"timeline":1},{"v":"Ended","spend":0,"alert":0,"timeline":0}]"#;

/// (键, 显示名, 类型, 数据源, 默认上表, 序)
type FieldDef = (&'static str, &'static str, &'static str, &'static str, i64, i64);

/// 到期模型决定注册哪一侧的日期字段：`next` 记下次到期日，`last` 记上次续费日 + 剩余天数。
///
/// 建库播种与**事后切换到期模型**共用这一份。切换那条路非补不可：库建成 `last` 时
/// `fields` 里从来没有 `next_renewal`，切成 `next` 之后 `due_from` 改读一个界面上
/// 根本造不出来的字段（字段面板只能建 `src='extra'` 的自定义列），整库到期日就此
/// 静默消失——表格里旧的"上次续费"列还显示着值，看着一切正常，时间线却空了。
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
    let renew_from =
        pick("renew_from").unwrap_or_else(|| cur["renew_from"].as_str().unwrap().into());
    if !RENEW_FROMS.contains(&renew_from.as_str()) {
        return Err(bad(format!("未知的续费起算方式：{renew_from}")).into());
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
    // 换到期模型就把新锚点那一侧的日期字段补进注册表：没有它，due_from 改读的那个字段
    // 在界面上既不在表格也不在详情表单，而字段面板只能建 extra 自定义列——用户没有任何
    // 途径把它造出来，整库到期日从此静默消失（切回去能恢复，但那要先猜到原因）。
    // ON CONFLICT DO NOTHING：已注册过就保持用户改过的显示名与上表设置，幂等。
    if anchor != cur["due_anchor"].as_str().unwrap_or_default() {
        let key = cur["key"].as_str().unwrap_or_default();
        for (k, fname, ftype, src, shown, fpos) in anchor_fields(&anchor) {
            tx.execute(
                "INSERT INTO fields(tbl,key,name,ftype,src,shown,pos,builtin,options)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,1,'[]')
                 ON CONFLICT(tbl,key) DO NOTHING",
                params![key, k, fname, ftype, src, shown, fpos],
            )?;
        }
    }
    tx.commit()?;
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

/// 有形状的文本类型（tel / url / email）的规范化。
///
/// 共同的分寸：**只拦一眼可辨的垃圾，不拦"不够完整"**。存量数据里就有 `+44` 这种只填了
/// 国家码的值，在写入口 400 掉等于让人打不开自己的旧条目；可疑但可能是真的，交给界面标出来
/// （电话号码的位数偏少由前端挂个问号提示，见 `telSuspect`）。
pub fn normalize_shaped(ftype: &str, raw: &str) -> anyhow::Result<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    match ftype {
        "tel" => {
            // **折叠必须先于校验。** 连续空白折叠成一个空格本就是为"从别处粘来的号码"
            // 准备的，而那种号码带的往往是全角空格（U+3000）——下面白名单里的空格是
            // ASCII 的，次序反过来就等于一边声明要折叠、一边把该折叠的输入 400 掉，
            // 报错还是「不该出现「　」」，那个字符渲染出来近似空白，几乎读不出所以然。
            let folded = t.split_whitespace().collect::<Vec<_>>().join(" ");
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
            // 没写协议就补 https://：多数人直接粘 `netflix.com`，而没有协议的串
            // 在 <a href> 里会被当成相对路径，点了跳到本站自己的一个不存在页面。
            // 协议按 RFC 3986 不分大小写：`HTTPS://…`（粘自旧文档，或输入法把首字母
            // 大写了）在浏览器里能开，这里也得认，顺手统一成小写存下来。
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
            // 界面用的是原生 <input type=date>，写不出别的形状；但接口与导入脚本能——
            // 而一个写坏的日期会让条目**掉出到期时间线、不再提醒**（首页的 undated 会点名它，
            // 所以不是全无声息，但等你看见已经过去几天了）。
            //
            // **认得出就补齐成标准形状，而不是拒掉**：`2026-8-15` chrono 本来就认，
            // 可这些日期是当字符串排序与比较的（`2026-8-15` 会排到 `2026-12-01` 后面），
            // 存回标准形状才对。与 tel 折叠空白、url 补协议同一条路子。
            let d = NaiveDate::parse_from_str(t, "%Y-%m-%d")
                .map_err(|_| bad(format!("日期要写成 2026-08-15 这样的形状：{t}")))?;
            Ok(d.format("%Y-%m-%d").to_string())
        }
        _ => Ok(t.to_string()),
    }
}

/// 币种：2–6 位字母，统一存大写。
///
/// **不卡死三位 ISO 码**：那今天不会误伤任何东西（生产在用的是 USD/CNY/EUR），但哪天要记
/// `USDT` 这类四位的就被自己的校验挡在门外了。这里要拦的是「这不是ISO码」那种一眼可辨的
/// 垃圾——它一旦落库，那笔钱就永远不进支出统计（汇率表查不到，只能单独占一行）。
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
    let rest = raw.split_once("://").map(|x| x.1).unwrap_or(raw);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split('@').next_back().unwrap_or(host); // 去掉 user:pass@
    (!host.is_empty() && host.contains('.')).then(|| host.to_lowercase())
}

/// 把某张表里有形状的字段就地规范化。字段类型是数据（存在 `fields` 表里），
/// 所以写入口要现查一次——没有这类列的表，这条查询返回空集。
///
/// `tbl` 就是字段注册表里的表名：库用库键，媒体用 `media`。**媒体那侧同样要过**，
/// 它的自定义列也能选 tel/url/email（"新建列"的类型下拉对两侧一视同仁）。
pub fn normalize_shaped_in(conn: &Connection, tbl: &str, b: &mut Value) -> anyhow::Result<()> {
    let mut stmt =
        conn.prepare("SELECT key, ftype FROM fields WHERE tbl=?1 AND ftype IN ('tel','url','email','date')")?;
    let cols: Vec<(String, String)> = stmt
        .query_map([tbl], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (k, ftype) in cols {
        // url 既可能是真列，也可能是 extra 里的域字段/自定义列
        if let Some(v) = b.get(&k).and_then(|v| v.as_str()) {
            let fixed = normalize_shaped(&ftype, v)?;
            b[&k] = json!(fixed);
        }
        if let Some(v) = b.get("extra").and_then(|e| e.get(&k)).and_then(|v| v.as_str()) {
            let fixed = normalize_shaped(&ftype, v)?;
            b["extra"][&k] = json!(fixed);
        }
    }
    Ok(())
}

fn normalize_shaped_fields(conn: &Connection, coll: i64, b: &mut Value) -> anyhow::Result<()> {
    let key: String = conn.query_row("SELECT key FROM collections WHERE id=?1", [coll], |r| {
        r.get(0)
    })?;
    // 币种自迁移 0013 起不是注册字段（并进了费用格），注册表那圈循环读不到它
    if let Some(c) = b.get("currency").and_then(|v| v.as_str()) {
        b["currency"] = json!(normalize_currency(c)?);
    }
    normalize_shaped_in(conn, &key, b)
}

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
    let mut b = b.clone();
    normalize_shaped_fields(conn, coll, &mut b)?;
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
    tx.execute(
        &format!(
            "INSERT INTO items(collection_id,{WRITE_COLS},pos) VALUES({})",
            (1..=vals.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(",")
        ),
        rusqlite::params_from_iter(vals),
    )?;
    let id = tx.last_insert_rowid();
    // 新条目可能捡到一个用过的号（items.id 不带 AUTOINCREMENT，SQLite 会复用删掉的 id）。
    // 通知去重键是 (kind, item_id, 到期日, 阈值, 渠道)，于是旧号留下的记录会让新条目在
    // 同一个到期日上被判成"已经发过"，静默漏提醒。台账是事实记录、必须留（名字已随
    // 迁移 0018 钉进那张表），通知日志只为去重服务、也没有读界面，新条目一落地就清掉它那份。
    let key: String = tx.query_row("SELECT key FROM collections WHERE id=?1", [coll], |r| r.get(0))?;
    tx.execute(
        "DELETE FROM notification_log WHERE kind=?1 AND item_id=?2",
        params![key, id],
    )?;
    tx.commit()?;
    Ok(id)
}

/// 局部更新的合并规则，**全项目只此一条**（媒体那侧同款）：
/// 请求里**出现**的键写入（`""` 与 `null` 都表示清空），**缺席**的键保持原值；
/// `extra` 作为一个整体值走同一条规则——出现即整份替换，缺席即保持。
///
/// 这里曾经是全量替换（PUT）：body 漏一列，那一列就被置空。于是每条写入路径都得先把
/// 整行铺进去再让当前值覆盖，而只要有一处没铺到就是一次静默的数据丢失——SIM 的周期、
/// 媒体的自定义列、条目图标、父条目都这样被一次保存清掉过。改成"缺席即保持"之后，
/// 这类事故在协议层面就不成立了，那些补偿代码也就没有存在的理由。
pub fn merge_over(cur: &Value, b: &Value, cols: impl Iterator<Item = &'static str>) -> Value {
    let mut out = serde_json::Map::new();
    for k in cols {
        let v = b.get(k).or_else(|| cur.get(k)).cloned().unwrap_or(Value::Null);
        out.insert(k.to_string(), v);
    }
    Value::Object(out)
}

pub fn update_item(conn: &Connection, id: i64, b: &Value) -> anyhow::Result<()> {
    let cur = conn
        .query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id=?1"), [id], item_row)
        .map_err(|_| missing("条目不存在"))?;
    let coll = cur["collection_id"].as_i64().unwrap_or_default();
    let mut b = merge_over(&cur, b, WRITE_COLS.split(',').map(str::trim));
    check_parent(conn, coll, Some(id), i(&b, "parent_id"))?;
    normalize_shaped_fields(conn, coll, &mut b)?;
    let mut vals = item_values(&b)?;
    let sets = WRITE_COLS
        .split(',')
        .enumerate()
        .map(|(n, c)| format!("{}=?{}", c.trim(), n + 1))
        .collect::<Vec<_>>()
        .join(",");
    vals.push(rusqlite::types::Value::from(id));
    conn.execute(
        &format!(
            "UPDATE items SET {sets},updated_at=datetime('now') WHERE id=?{}",
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
    // 报真正删掉的条数，不是请求里的 id 个数——不存在的 id 也算进去的话，这个数字就是编的
    let mut deleted = 0usize;
    for id in &ids {
        let logo: Option<String> = tx
            .query_row("SELECT logo FROM items WHERE id=?1", [id], |r| r.get(0))
            .unwrap_or(None);
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
/// anchor='next' 推进 next_renewal（逾期则连推到今天之后），anchor='last' 把上次续费记为今天。
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
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            },
        )
        .ok();
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
    // 名字当场钉进台账。只记 (kind, item_id) 的话，条目一删这笔账就没了名字，而 id 被
    // 复用之后它还会挂到新条目名下——台账是事实记录，得能自证，不该跟着当前条目变。
    tx.execute(
        "INSERT INTO renewal_ledger(kind,item_id,renewed_at,amount,currency,note,item_name,coll_name)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            key,
            id,
            today.to_string(),
            f(b, "amount").or(price),
            s(b, "currency").or(currency),
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
    // 文件名带的是**秒级**时间戳：同一秒里传第二张（换图时连点两下就够了）新旧同名，
    // 于是刚写好的新文件恰好就是这里要删的"旧文件"——库里记着名字、文件却没了，
    // 图标从此 404。同名时不必删：上面那次 write 已经原地覆盖过了。
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

/// 取图标只连**条目自己那个站**，且只走这几条常规路径。
///
/// 这是本项目第二条默认关着的出网（第一条是汇率），由用户在详情表单里点一下才发生：
/// 你已经是这个站的客户，向它要一张 favicon 不多泄露任何东西——而经第三方 favicon 服务
/// 取，等于把整份订阅域名清单告诉别人，与「数据主权」的初衷相左。
const FAVICON_PATHS: &[&str] = &["/favicon.ico", "/favicon.png", "/apple-touch-icon.png"];

/// 服务端替用户发请求前必须挡住内网：这台机器往往和别的服务同处一个局域网，
/// 不挡的话「取图标」就成了一个替人探测内网的按钮（`image_path_ok` 是同一种防线）。
/// 一个 IP 是否算"公网"。纯函数，好穷举测试。
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
            !(v6.is_loopback() || v6.is_unspecified() || unique_local || link_local)
        }
    }
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

/// 字面形状这一关：明显的本机名与字面内网地址直接拒。
///
/// **这只是第一道。** 光看字面拦不住「公共域名的 A 记录指向 127.0.0.1」这种——
/// `localtest.me` 就是现成的例子，根本不需要 DNS 重绑定。所以真正发请求前还要过
/// `host_is_public` 把解析结果也验一遍。
fn public_host_ok(host: &str) -> bool {
    let bare = bare_host(host);
    if bare.is_empty()
        || bare.eq_ignore_ascii_case("localhost")
        || bare.ends_with(".localhost")
        || bare.ends_with(".local")
    {
        return false;
    }
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return public_ip_ok(&ip);
    }
    bare.contains('.')
}

/// 字面形状 + 解析结果双重校验，**并把校验过的地址交回去钉死**。
/// 返回 None＝不许连。**每一跳重定向都要重新过这里。**
///
/// 为什么要把地址交回去：只校验不钉的话，reqwest 连接时会**再解析一次**，
/// 两次之间 DNS 可以翻脸（DNS rebinding / TOCTOU）——校验过的和真正连上的不是同一台机器。
///
/// 注意：配了 `meta.proxy` 时域名由代理解析，预解析与钉地址都不生效——
/// 那种部署下真正的出口管控在代理那一侧。
async fn resolve_public(host: &str, port: u16) -> Option<std::net::SocketAddr> {
    if !public_host_ok(host) {
        return None;
    }
    let bare = bare_host(host);
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return Some(std::net::SocketAddr::new(ip, port)); // 字面 IP 上面已验过
    }
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((bare, port)).await.ok()?.collect();
    let ips: Vec<std::net::IpAddr> = addrs.iter().map(|a| a.ip()).collect();
    // 有一条落内网就整体拒；否则钉住第一条——钉的必须是刚校验过的那一批里的
    resolved_ips_ok(&ips).then(|| addrs[0])
}

/// 响应体上限。**reqwest 没有默认上限**，唯一的边界是那 30s 总超时——也就是
/// 「带宽 × 30s」：条目的网址指向被劫持的站（或跳到一个大文件），千兆链路下最坏是数 GB
/// 进到这个单二进制进程的内存里，而容器内存配额常只有几百 MB，OOM kill 会把通知调度
/// 一起带走。SSRF 那几道防线管的是「连到哪」，不管「读多少」，是正交的缺口。
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

/// 从首页的 `<link rel="icon">` 里找图标地址。找不到就返回空，调用方退回常规路径。
///
/// 只做一次 GET 与一段正则——为这点事引 HTML 解析器不值当，而 `rel` 里含 icon 的
/// link 标签形状足够固定。取不到、超时、页面过大都当作"没发现"，不算失败。
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

/// 发一个 GET，自己跟重定向，**每一跳都重新校验目标主机**。
///
/// 不能交给 reqwest 自动跟：它默认跟 10 跳且不会回头问我们目标合不合法，于是
/// `https://正常站/x → 302 → http://10.0.0.5/` 一路直达内网，前面那道防线形同虚设。
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

/// 从 HTML 里挑出图标地址。纯函数，好上单测——真去连站点的那层只负责取回页面。
///
/// **一律按字符切，不能按字节。** 页面里随便一个多字节字符（实测 Netflix 的 HTML 里有个
/// `𝔽`）就会让 `&body[..n]` 落在字符中间直接 panic，把整个请求处理线程带走；
/// 与 `ics::fold` 当年踩的是同一个坑。只做正则式的粗解析——为这点事引 HTML 解析器不值当。
fn icon_links_in(body: &str, scheme: &str, host: &str) -> Vec<String> {
    let head: String = body.chars().take(200_000).collect();
    let mut out = Vec::new();
    for tag in head
        .split('<')
        .filter(|t| t.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("link")))
    {
        // rel 得**真的**是图标：只看 rel 属性自己的值。曾经图省事扫 rel 后面 40 个字符，
        // 于是 `<link rel="stylesheet" href="/icon-theme.css">` 也被当成图标捡了进来
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

/// 取标签里某个属性的引号值，属性名按 ASCII 大小写不敏感匹配。
///
/// 直接在原串上按字节扫：属性名、`=`、引号全是 ASCII，落点必是字符边界，
/// 既不必造一份小写副本来定位（`to_lowercase` 可能改变字节长度，索引就对不上了），
/// 也不会把网址里的大小写抹掉。
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
    let (raw, proxy) = {
        let conn = app.db.lock().unwrap();
        let stored: Option<Option<String>> = conn
            .query_row("SELECT url FROM items WHERE id=?1", [id], |r| r.get(0))
            .ok();
        let Some(stored) = stored else {
            return Err(missing("条目不存在").into());
        };
        let raw = s(&b, "url").or(stored).unwrap_or_default();
        (raw, crate::db::get_setting(&conn, "meta.proxy").unwrap_or_default())
    };
    if raw.trim().is_empty() {
        return Err(bad("这个条目还没有网址").into());
    }
    let full = normalize_shaped("url", &raw)?;
    let host = url_host(&full).ok_or_else(|| bad("网址里看不出域名"))?;
    if !public_host_ok(&host) {
        return Err(bad("只能从公网站点取图标").into());
    }
    // 协议沿用条目自己那个网址：恒拼 https 的话，明写 http:// 的站点每条路径都在做
    // TLS 握手，全数"连不上"，最后报出来的却是"这个站可能不给自动抓取"——方向全错
    let scheme = full.split_once("://").map(|x| x.0).unwrap_or("https").to_string();
    // 不带 UA 会被一部分站点特判成爬虫直接 403（实测 Stack Overflow 就是），
    // 与 scripts/update-fx-baseline.py 踩过的是同一个坑
    const UA: &str = "kalends-icon-fetch";
    // 整轮总截止：候选最多 1 + 4 + 3 = 8 条、串行试、每条各有 30s 上限，对着一个
    // 黑洞式丢包的目标能让按钮在"取图标…"上停约四分钟。常见失败（拒绝/404/TLS 被挡）
    // 都在秒级，这道闸只砍掉最坏那条尾巴
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(45);
    let started = std::time::Instant::now();
    let mut last = String::from("没找到图标");
    // 先问网页自己：多数站点的图标不在 /favicon.ico，而是 <link rel="icon"> 指到别处
    // （实测 Cloudflare 三条常规路径全 404）。取不到就退回常规路径挨个试。
    let mut paths: Vec<String> = discover_icon_paths(&proxy, UA, &scheme, &host).await;
    paths.extend(FAVICON_PATHS.iter().map(|p| (*p).to_string()));
    for path in paths {
        if started.elapsed() > DEADLINE {
            last = format!("{last}；试了 {}s 还没结果，先收手", started.elapsed().as_secs());
            break;
        }
        let target = if path.starts_with("http") {
            path.clone()
        } else {
            format!("{scheme}://{host}{}", if path.starts_with('/') { path.clone() } else { format!("/{path}") })
        };
        let resp = match get_public(&proxy, &target, UA).await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last = format!("{host} 返回 {}", r.status());
                continue;
            }
            Err(e) => {
                last = e;
                continue;
            }
        };
        let bytes = match crate::notify::body_capped(resp, ICON_MAX).await {
            Ok(x) => x,
            Err(e) => {
                last = e;
                continue;
            }
        };
        // 格式按**字节**认，不从 URL 后缀猜：`/favicon.ico` 实际返回 PNG 字节是极常见的
        // 部署，而现代站点的 `<link rel="icon" href="/icon">` 干脆没有扩展名（旧写法
        // rsplit('.') 会猜出 "com/icon"，>4 字符再回落 "ico"）——两类都会被魔数校验
        // 误拒，用户看到的却是"这个站可能不给自动抓取"。放行的格式集合一点没放宽，
        // 只是把"声明"从猜测换成事实，校验反而更诚实
        let Some(ext) = sniff_image_ext(&bytes) else {
            last = format!("{target} 取到的不是可用图片");
            continue;
        };
        // 体积上限与旧文件清理仍由 set_logo 兜着
        let conn = app.db.lock().unwrap();
        match set_logo(&app, &conn, id, ext, &bytes) {
            Ok(name) => return Ok(Json(json!({ "logo": name, "from": target }))),
            Err(e) => last = format!("{target} 取到的不是可用图片（{e}）"),
        }
    }
    // 取不到就说清楚下一步：有些站（尤其 Cloudflare 前置的）会按 TLS 指纹挡掉非浏览器
    // 客户端，那不是能靠改请求头绕过去的东西——冒充浏览器指纹要引重依赖且性质上是欺骗，
    // 不如老实告诉用户手动传一张
    Err(bad(format!("{last}；这个站可能不给自动抓取，可以手动选一张图片")).into())
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

    /// 有形状的类型里，日期与币种是 2026-08-15 补的：界面挡得住（原生 date 控件、币种下拉），
    /// 接口与导入脚本挡不住，而写坏的后果都不出声——坏日期让条目掉出到期时间线、
    /// 坏币种让那笔钱永远不进支出统计。
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

    /// 局部更新的合并规则：缺席即保持、出现即写入、`""` 与 `null` 都是清空、
    /// `extra` 作为一个整体值。这条规则是整个写入协议的地基——它一松，前端就得重新
    /// 长出那套"先铺整行再覆盖"的补偿代码，而漏铺一处就是一次静默的数据丢失。
    #[test]
    fn a_patch_only_touches_the_keys_it_carries() {
        let cur = json!({
            "name": "Netflix", "price": 15.49, "currency": "USD", "cycle": "monthly",
            "next_renewal": "2026-09-01", "logo": "item-1.png",
            "extra": { "category": "Streaming", "payment_method": "Visa" },
        });
        let cols = || ["name", "price", "currency", "cycle", "next_renewal", "logo", "extra"].into_iter();

        // 只发一个键：其余原样，连表单里根本没有的 logo 也在
        let got = merge_over(&cur, &json!({ "name": "改过名" }), cols());
        assert_eq!(got["name"], json!("改过名"));
        assert_eq!(got["price"], json!(15.49));
        assert_eq!(got["logo"], json!("item-1.png"));
        assert_eq!(got["extra"]["payment_method"], json!("Visa"));

        // 清空要显式说出来：null 与空串都算，别的键不受连累
        let got = merge_over(&cur, &json!({ "price": null, "next_renewal": "" }), cols());
        assert_eq!(got["price"], Value::Null);
        assert_eq!(got["next_renewal"], json!(""));
        assert_eq!(got["currency"], json!("USD"));

        // extra 是一个整体值：出现即整份替换（少写的键就是要删的键）
        let got = merge_over(&cur, &json!({ "extra": { "category": "AI" } }), cols());
        assert_eq!(got["extra"], json!({ "category": "AI" }));

        // 现值里没有、请求里也没有的键 → NULL（新列刚加出来时就是这个形状）
        let got = merge_over(&json!({ "name": "x" }), &json!({}), cols());
        assert_eq!(got["price"], Value::Null);
        assert_eq!(got["name"], json!("x"));
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

    /// 库属性也是模板的一部分：到期锚点、续费起算方式、日历标题的副标题、名称格小字、
    /// 续费动作说法、进日历描述的备注键——写错任何一个，到期时间线与 ICS 就跟预置库
    /// 长得不一样。`renew_from` 尤其要钉住：迁移 0017 把 vps 置成 schedule、sims 置成
    /// today，模板这侧漏改一个，删掉预置库再照模板建回来行为就变了。
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

    /// 服务端替用户发请求前必须挡住内网：这台机器往往和别的服务同处一个局域网，
    /// 不挡的话「从网站取图标」就成了一个替人探测内网的按钮。
    /// 解析结果这一关：**光看字面拦不住"公共域名指向 127.0.0.1"**（`localtest.me`
    /// 就是现成例子，不需要 DNS 重绑定）。真正发请求前要把解析出来的地址也验一遍。
    #[test]
    fn resolved_addresses_are_checked_too() {
        use std::net::IpAddr;
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
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

    #[test]
    fn fetching_icons_refuses_to_touch_the_local_network() {
        for bad in [
            "127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "172.16.0.5",
            "169.254.169.254", "0.0.0.0", "[::1]", "[fe80::1]", "[fd00::1]", "nas.local", "box.localhost",
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
    /// 实测 Netflix 的首页里就有个 `𝔽`（四字节），当时整个连接直接断掉。
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
        assert_eq!(h(r#"<link rel='apple-touch-icon' href='/t.png'>"#), vec!["/t.png"]);
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

}
