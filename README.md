# Kalends

> Self-hosted, local-first tracker for everything that renews — subscriptions, SIM-card keep-alives and VPS/cloud servers come ready-made, and you can define your own kinds — plus a personal media library for films, series, anime and games. One Rust binary, one SQLite file, zero cloud.

Named after the Roman *Kalendae*: the first day of the month, when debts came due — the origin of the word "calendar".

**English** · [中文](#中文说明)

## Features

- **Renewal center** — anything that comes due, on one merged timeline. Subscriptions, SIM keep-alives and VPS/cloud servers ship as ready-made collections; rename them, delete them, or add your own (domains, insurance, licences) from the interface.
  - Each collection owns its columns and picks how due dates work: store the next due date, or derive it from the last renewal plus a cycle (weekly through triennial, or a custom day count like 181)
  - Multi-currency native pricing (no forced conversion), price history, service → tier hierarchy with collapsible sub-items, per-item icons
  - Status carries meaning rather than just a label: each value declares whether it counts toward spend, fires alerts, and appears on the timeline. That is how `Deferred` works as a comparison-shopping catalogue that does none of the three, and `Ending` stays in the calendar feed while going quiet.
- **One-click renewal logging** — advances the cycle and writes a ledger entry
- **Notion-style tables** — every column carries a field type (text / number / select / multi-select / status / date / rating) that drives its sort order, filter UI and cell rendering. Click a cell to edit it in place. Add your own columns — the column registry is data, so a new collection gets a usable set of columns the moment you create it. Rename, recolor and reorder select options and the change propagates to every row. Drag column widths and order, hide columns, collapse sub-items. Sort and filter state lives in the browser, so two devices can look at the same table differently.
- **Notifications** — Telegram bot and SMTP email, N-days-before thresholds plus a daily digest, per-channel proxy support, deduplicated and catch-up-safe; plus an **ICS calendar feed** your phone subscribes to natively
- **Media library** — douban-style metadata fields, 5-star ratings, poster wall / table views, on-demand TMDB fetch (zh-CN) with posters cached locally, bulk import API
- **Local-first by construction** — nightly rotating SQLite snapshots + plain-text JSONL exports, optional PIN gate, PWA, no telemetry; the only network egress is metadata fetch and the notification channels you configure
- **Module switch** — deploy only the renewal center or only the media library with one env var

## Quick start

```bash
cargo run                      # http://127.0.0.1:4180, data in ./data/
```

For production use, see [deploy/DEPLOY.md](deploy/DEPLOY.md) (Docker Compose + reverse proxy). Environment variables: `KALENDS_ADDR`, `KALENDS_DATA`, `KALENDS_MODULES`.

## License

[AGPL-3.0](LICENSE)

---

## 中文说明

自托管、本地优先的个人台账：**续费中心**（预置订阅 / SIM 卡保号 / VPS·云服务器，也可自建库）加**媒体库**（影视 / 剧集 / 动画 / 游戏）。单个 Rust 二进制、单个 SQLite 文件，数据从头到尾在自己盘上。

名字取自罗马历的朔日 *Kalendae*——每月初一收账还债之日，也是 calendar 一词的词源。

### 功能

**续费中心**：凡是会到期的东西，合并成一条到期时间线。订阅、SIM 保号、VPS 是预置好的三个「库」，可以改名、删掉，也可以自己加——域名、保险、证件都行，界面上建。

- 每个库自己有哪些列、到期怎么算都由库说：要么直接记下次到期日，要么从上次续费按周期推（周付到三年付，或者像 181 天这样的自定义天数）
- 原币记账（CNY/USD/EUR… 各算各的，不强制折算）、涨价历史、"服务 → 套餐档位"父子结构可折叠、每个条目能配图标
- 状态不只是个标签，而是带含义的：每个状态值自己声明计不计支出、发不发提醒、上不上时间线。所以 `Deferred` 可以当比价目录（三样都不算），`Ending` 可以留在日历里但不再吵你
- 一键「已续费 / 已保号」：推进周期并写入台账；动作说法也是库的属性，所以 SIM 那栏写的是"已保号"而不是"已续费"

**表格视图**：照着 Notion 的数据库表做——每列都属于一种字段类型（文本 / 数字 / 单选 / 多选 / 状态 / 日期 / 星级），类型决定这列怎么排序、筛选面板长什么样、单元格怎么渲染。点格子就地改，不用开表单。可以自己加列——列本身就是数据，所以新建一个库时它立刻就有一套能用的列。单选多选的选项能改名、配色、手动调序，改动传播到所有行。列宽列序随手拖，列能隐藏，套餐档位那种子行能折叠。排序筛选这些视图状态存在浏览器本地，所以手机和电脑可以各看各的。

**提醒**：Telegram Bot 与 SMTP 邮件双渠道，提前 N 天逐档提醒 + 每日摘要，去重、宕机补发、渠道可单独配代理；另有 **ICS 日历订阅地址**，手机日历原生提醒，零推送依赖。

**媒体库**：豆瓣风格字段（导演 / 编剧 / 类型 / 豆瓣评分快照等）、5 星评分、海报墙与表格双视图、按需 TMDB 抓取元数据（中文）并把海报缓存到本地、批量导入接口（含 Notion 迁移示例脚本 `scripts/notion-import.py`）。

**数据安全**：每日快照轮转（保留 14 份）+ 全表 JSONL 明文导出；可选 PIN 门禁；零遥测，出网仅限你主动触发的元数据抓取与自行配置的通知渠道。

### 快速开始与部署

```bash
cargo run    # http://127.0.0.1:4180
```

生产部署（Docker Compose + 反向代理 + 单模块开关）见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。TMDB 抓取需在设置页填入免费申请的 API key；被墙环境可为元数据与通知渠道分别配置代理。

### 仓库结构

```
src/            axum 服务、到期引擎、通知、备份、TMDB 客户端
migrations/     数据库迁移（编译期嵌入，PRAGMA user_version 版本控制）
assets/         前端（原生 JS，无构建步骤，编译期嵌入二进制）
scripts/        Notion 迁移示例脚本、前端端到端验证、数据迁移演练与接口对拍
deploy/         Docker Compose 与部署文档
```
