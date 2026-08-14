<div align="center">
  <img src="assets/icon.svg" alt="" width="112">
  <h1>Kalends</h1>
  <p><b>朔日台账</b> — the new-moon ledger</p>
  <p><b>English</b> · <a href="#中文说明">中文</a></p>
</div>

> Self-hosted tracker for everything that renews — subscriptions, SIM keep-alives, VPS boxes, and whatever else you care to define — plus a media library for films, series, anime and games. One Rust binary, one SQLite file, no account anywhere.

Named after the Roman *Kalendae*: the first day of the month, when debts came due. It is where the word "calendar" comes from — and the new moon that opened each Roman month is the crescent in the icon, filling up bubble by bubble until the account falls due.

## What it does

Everything that expires lands on one timeline. Subscriptions, SIM keep-alives and VPS servers ship as ready-made collections; rename them, delete them, or build your own from a template (domains, insurance, ID documents) or from an empty one. A template only decides what the collection looks like on day one. Afterwards its fields behave like any other, so you can rename them, edit their options, or throw them away.

Each collection owns its columns and decides how due dates work: store the next due date directly, or derive it from the last renewal plus a cycle. Cycles run weekly through triennial, plus lifetime and arbitrary day counts, so a 181-day SIM keep-alive is a normal setting rather than a workaround.

Prices are stored in their original currency and totalled per currency; nothing is quietly converted. Items nest one level deep (service → tier), so the plans you are comparing and the one you actually pay for sit in the same table. Marking something renewed moves the date on and writes a ledger entry you can read back from the settings page.

Status values carry meaning rather than decoration. Each one declares whether it counts toward spend, fires alerts, and shows on the timeline, and you flip those three from the column header menu. `Deferred` has all three off, which turns it into a price-comparison shelf. `Ending` keeps its calendar entry and stops its own reminders — the daily digest still lists it, because the digest is the whole timeline.

### Tables

Modelled on Notion databases. Every column has a field type — text, number, select, multi-select, status, date, rating — and the type drives sorting, the filter panel and how the cell renders. Click a cell to edit it in place; no form to open.

Columns are data, so a new collection arrives with a working set. Add your own, rename them, recolour and hand-sort select options with changes propagating to every row, drag widths and order, hide what you don't need, collapse sub-rows. Field order and "show in table" belong to the collection and follow it across devices. Sort, filter and column width stay in the browser, so your phone and your laptop can disagree.

### Reminders and calendar

Telegram bot and SMTP mail, N-days-before thresholds plus a daily digest. Telegram can go through its own proxy. Sends are deduplicated on (kind, item, due date, threshold, channel) and catch up on whatever was missed while the server was down. There is also an ICS feed whose events carry a one-day alarm — subscribe from your phone's calendar and you can skip push notifications entirely.

### Media library

Douban-shaped fields (directors, writers, genres, a snapshot of the Douban rating and reviews), 5-star ratings, poster wall and table views. TMDB lookup on demand in Chinese, posters cached to disk. Bulk import over the API; `scripts/notion-import.py` is the script used to move off Notion.

### Backups and privacy

A SQLite snapshot every night after 03:30, 14 kept on a rolling basis, plus a plain-text JSONL dump of every table that stays readable without Kalends. Optional PIN gate. No telemetry, and nothing leaves the machine on its own: the outbound traffic is a TMDB lookup, an exchange-rate refresh or a favicon fetch — each one only when you ask for it — plus the notification channels you configure.

You can ship half of it. `KALENDS_MODULES=renewals` or `=media` removes the other half's routes, interface and background jobs.

## Quick start

```bash
cargo run     # http://127.0.0.1:4180, data in ./data/
```

TMDB lookups need a free API key, entered on the settings page. On a phone, "add to home screen" gives you a full-screen app.

For a real deployment (Docker Compose, reverse proxy, single-module setups) see [deploy/DEPLOY.md](deploy/DEPLOY.md). Environment variables: `KALENDS_ADDR` (default `127.0.0.1:4180`), `KALENDS_DATA` (default `./data`), `KALENDS_MODULES` (default `renewals,media`).

Keep the SQLite file on local disk. Locking over SMB or NFS is not reliable enough to trust a ledger to.

## License

[AGPL-3.0](LICENSE)

---

## 中文说明

自托管的个人台账：**续费中心**（预置订阅 / SIM 卡保号 / VPS，也能自己建库）加**媒体库**（影视 / 剧集 / 动画 / 游戏）。单个 Rust 二进制、单个 SQLite 文件，数据全程在自己盘上。

名字取自罗马历的朔日 *Kalendae*——每月初一收账还债之日，也是 calendar 的词源。图标里那弯被气泡一颗颗补圆的薄荷朔月，就是它：账期数满成圆，朔日收账。

### 它做什么

会到期的东西全汇到一条时间线上。订阅、SIM 保号、VPS 是预置的三个「库」，能改名能删；要新的就自己建，挑域名 / 保险 / 证件的模板，字段和到期模型直接就位，也可以从空白起步。模板只决定这个库刚建好时长什么样，落地之后就是普通字段，照样改名、改选项、删掉。

每个库自己决定有哪些列、到期怎么算：要么直接记下次到期日，要么从上次续费按周期推。周期从周付到三年付，另有买断和任意天数，181 天的 SIM 保号在这里是个正常档位，不用绕。

价格按原币存、分币种统计，不替你折算。条目可以套一层父子（服务 → 套餐档位），于是比价的那几档和你真在付的那档待在同一张表里。点一下「已续费」把日期往后推，同时记一笔账，可以在设置页里回看。

状态不只是个标签。每个状态值自己声明计不计支出、发不发提醒、上不上时间线，这三个勾在表头菜单里改。`Deferred` 三个全关，于是成了比价目录；`Ending` 留在日历里，不再单独提醒你——每日摘要仍然会列出它，因为摘要是到期时间线的全景。

### 表格

照 Notion 的数据库表做。每列属于一种字段类型——文本 / 数字 / 单选 / 多选 / 状态 / 日期 / 星级——类型决定这列怎么排序、筛选面板长什么样、格子怎么渲染。点格子就地改，不用开表单。

列本身是数据，新建的库一上来就有一套能用的列。可以自己加列、改名，给单选多选的选项配色和手动调序（改动传播到所有行），拖列宽列序，隐藏列，折叠子行。字段顺序和「上不上表格」是库的属性，跟着账本走；排序、筛选、列宽存在浏览器本地，所以手机和电脑可以各看各的。

### 提醒与日历

Telegram Bot 与 SMTP 邮件，提前 N 天逐档提醒加每日摘要，Telegram 可以单独走代理。发送按（种类, 条目, 到期日, 档位, 渠道）去重，停机期间漏掉的会补发。另有 ICS 订阅地址，事件自带提前一天的闹钟——手机日历订上，推送就可以不要了。

### 媒体库

豆瓣式字段（导演 / 编剧 / 类型，豆瓣评分与短评快照），5 星评分，海报墙与表格双视图。按需调 TMDB 抓中文元数据，海报落到本地。批量导入走接口，`scripts/notion-import.py` 是当初从 Notion 搬家用的脚本。

### 备份与隐私

每天 03:30 之后做一份 SQLite 快照，滚动保留 14 份；同时把每张表导成 JSONL 明文，不装 Kalends 也读得懂。可选 PIN 门禁。零遥测，也不会自己往外发东西：出网只有 TMDB 抓取、拉取实时汇率、从网站取图标这三件——都得你点一下才发生——加上你自己配的通知渠道。

只要一半也行：`KALENDS_MODULES=renewals` 或 `=media`，另一半的接口、界面、后台任务整个不存在。

### 快速开始与部署

```bash
cargo run    # http://127.0.0.1:4180，数据在 ./data/
```

TMDB 抓取要先在设置页填一个免费申请的 API key。手机上「添加到主屏幕」可以全屏运行。

生产部署（Docker Compose、反向代理、单模块开关）见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。环境变量：`KALENDS_ADDR`（默认 `127.0.0.1:4180`）、`KALENDS_DATA`（默认 `./data`）、`KALENDS_MODULES`（默认 `renewals,media`）。

SQLite 文件务必放本地磁盘，SMB / NFS 的文件锁不够可靠，别拿账本去赌。被墙的网络环境里，设置页有一个共用的出网代理（管 TMDB、汇率、取图标），Telegram 另有自己的一格。

### 仓库结构

```
src/            axum 服务、到期引擎、通知、备份、TMDB 客户端
migrations/     数据库迁移（编译期嵌入，PRAGMA user_version 记版本）
assets/         前端（原生 JS，无构建步骤，编译期嵌入二进制）
scripts/        Notion 迁移脚本、前端端到端验证、迁移演练与接口对拍
deploy/         Docker Compose 与部署文档
```

改了 `assets/` 要重新 `cargo build` 才生效。
