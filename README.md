# Kalends

> Self-hosted, local-first tracker for everything that renews — subscriptions, SIM-card keep-alives, VPS/cloud servers — plus a personal media library for films, series, anime and games. One Rust binary, one SQLite file, zero cloud.

Named after the Roman *Kalendae*: the first day of the month, when debts came due — the origin of the word "calendar".

**English** · [中文](#中文说明)

## Features

- **Renewal center** — three kinds of recurring things, one merged due timeline:
  - *Subscriptions*: multi-currency native pricing (no forced conversion), service → tier hierarchy, price history, statuses for active / planned / comparison-shopping / ended
  - *SIM keep-alive*: custom day cycles (90 / 181 / 365…), keep-alive action notes, remaining-days progress
  - *VPS / cloud servers*: specs, network routes, locations, monthly through triennial cycles, and an "ending" state that stays visible on the timeline without alerting
- **One-click renewal logging** — advances the cycle and writes a ledger entry
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

自托管、本地优先的个人台账：**续费中心**（订阅 / SIM 卡保号 / VPS·云服务器）加**媒体库**（影视 / 剧集 / 动画 / 游戏）。单个 Rust 二进制、单个 SQLite 文件，数据从头到尾在自己盘上。

名字取自罗马历的朔日 *Kalendae*——每月初一收账还债之日，也是 calendar 一词的词源。

### 功能

**续费中心**：三类周期性事物共用一条合并到期时间线与统一提醒。

- 订阅：原币记账（CNY/USD/EUR… 各算各的，不强制折算）、"服务 → 套餐档位"父子结构、涨价历史；状态覆盖在订 / 计划 / 比价观望 / 已停
- SIM 保号：自定义周期天数（90 / 181 / 365…）、保号动作备注、剩余天数进度条
- VPS：规格 / 线路 / 地点、月付到三年付全周期；"预结束"状态保留在时间线上但不再提醒、不计支出
- 一键「已续费 / 已保号」：推进周期并写入台账

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
scripts/        Notion 迁移示例脚本
deploy/         Docker Compose 与部署文档
```
