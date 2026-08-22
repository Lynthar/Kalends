<div align="center">
  <img src="assets/icon.svg" alt="" width="112">
  <h1>Kalends</h1>
  <p><b>朔日台账</b> — the new-moon ledger</p>
  <p><b>English</b> · <a href="README.zh-CN.md">中文</a></p>
</div>

> Self-hosted tracker for everything that renews — subscriptions, SIM keep-alives, VPS boxes, and whatever else you care to define — plus a media library for films, series, anime and games. One Rust binary, one SQLite file, no account anywhere.

Named after the Roman *Kalendae*: the first day of the month, when debts came due. It is where the word "calendar" comes from — and the new moon that opened each Roman month is the crescent in the icon, filling up bubble by bubble until the account falls due.

## What it does

Everything that expires lands on one timeline. Subscriptions, SIM keep-alives and VPS servers ship as ready-made collections; rename them, delete them, or build your own from a template (domains, insurance, ID documents) or from an empty one. A template only decides what the collection looks like on day one. Afterwards its fields behave like any other, so you can rename them, edit their options, or throw them away.

Each collection owns its columns and decides how due dates work: store the next due date directly, or derive it from the last renewal plus a cycle. Cycles run weekly through triennial, plus lifetime and arbitrary day counts, so a 181-day SIM keep-alive is a normal setting rather than a workaround.

Prices are stored in their original currency and totalled per currency; nothing is quietly converted. Items nest one level deep (service → tier), so the plans you are comparing and the one you actually pay for sit in the same table. Marking something renewed moves the date on and writes a ledger entry you can read back from the settings page.

Status values carry meaning rather than decoration. Each one declares whether it counts toward spend, fires alerts, and shows on the timeline, and you flip those three from the column header menu. `Deferred` has all three off, which turns it into a price-comparison shelf. `Ending` keeps its calendar entry and stops its own reminders — the daily digest still lists it, because the digest is the whole timeline.

### Tables

Modelled on Notion databases. Every column has a field type — text, number, select, multi-select, status, date, phone, link, mail — and the type drives sorting, the filter panel and how the cell renders. Click a cell to edit it in place; no form to open.

Columns are data, so a new collection arrives with a working set. Add your own, rename them, recolour and hand-sort select options with changes propagating to every row, drag widths and order, hide what you don't need, collapse sub-rows. Field order and "show in table" belong to the collection and follow it across devices. Sort, filter and column width stay in the browser, so your phone and your laptop can disagree.

### Reminders and calendar

Telegram bot and SMTP mail, N-days-before thresholds plus a daily digest. Telegram can go through its own proxy. Sends are deduplicated on (kind, item, due date, threshold, channel) and catch up on whatever was missed while the server was down. There is also an ICS feed whose events carry a one-day alarm — subscribe from your phone's calendar and you can skip push notifications entirely.

### Media library

Douban-shaped fields (directors, writers, genres, a snapshot of the Douban rating and reviews), your own score out of ten next to Douban's, poster wall and table views. TMDB lookup on demand in Chinese, posters cached to disk. Bulk import over the API; `scripts/notion-import.py` is the script used to move off Notion.

### Backups and privacy

A SQLite snapshot every night after 03:30, 14 kept on a rolling basis, plus a plain-text JSONL dump of every table that stays readable without Kalends. Optional PIN gate. No telemetry, and nothing leaves the machine on its own: the outbound traffic is a TMDB lookup, an exchange-rate refresh or a favicon fetch — each one only when you ask for it — plus the notification channels you configure.

You can ship half of it. `KALENDS_MODULES=renewals` or `=media` removes the other half's routes, interface and background jobs.

## Quick start

```bash
cargo run     # http://127.0.0.1:4180, data in ./data/
```

TMDB lookups need a free API key, entered on the settings page. On a phone, "add to home screen" gives you a full-screen app.

For a real deployment (Docker Compose, reverse proxy, single-module setups) see [docs/user-guide.md](docs/user-guide.md). Environment variables: `KALENDS_ADDR` (default `127.0.0.1:4180`), `KALENDS_DATA` (default `./data`), `KALENDS_MODULES` (default `renewals,media`).

Behind a restrictive network, the settings page has one shared outbound proxy covering TMDB lookups, exchange-rate refreshes and favicon fetches; Telegram gets its own proxy field.

Keep the SQLite file on local disk. Locking over SMB or NFS is not reliable enough to trust a ledger to.

Building has the same constraint. If the repository itself sits on a network share, send Cargo's output to a local directory first — `export CARGO_TARGET_DIR=~/.cache/kalends-target` — because incremental compilation wants file locks those filesystems don't provide, and without it `cargo build` stops at a bare `os error 45`.

## Repository layout

```
src/            axum server, renewal engine, notifications, backups, TMDB client
migrations/     database migrations (embedded at compile time, versioned by PRAGMA user_version)
assets/         frontend (vanilla JS, no build step, embedded at compile time; js/ splits into eight files loaded in order)
scripts/        Notion migration, frontend end-to-end checks, migration rehearsals and API diffing
deploy/         Docker Compose and deployment docs
```

Changes under `assets/` need a fresh `cargo build` to take effect.

## License

[AGPL-3.0](LICENSE)
