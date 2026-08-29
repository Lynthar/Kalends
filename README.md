<div align="center">

<img src="assets/icon.svg" alt="Kalends" width="96">

# Kalends

[![license](https://img.shields.io/github/license/Lynthar/Kalends)](LICENSE)
[![release](https://img.shields.io/github/v/release/Lynthar/Kalends)](https://github.com/Lynthar/Kalends/releases)

</div>

Self-hosted renewal tracker — subscriptions, SIM keep-alives, VPS boxes. One Rust binary, one SQLite file.

English | [简体中文](README.zh-CN.md)

Anything with a next date goes on one timeline. Subscriptions, the prepaid SIM
you have to top up every 181 days to keep the number, VPS boxes, domains,
insurance, documents that expire.

I built it to replace a handful of Notion databases: online-only, sluggish past a
few hundred rows, and with no way to say whether a status counts as spending. The
data model is the same shape — libraries with typed columns — but it comes out as
one binary and one SQLite file, no accounts, nothing phoning home. Point it at a
folder on a NAS and forget it's there.

## Features

- **Seven library templates** — subscriptions, SIM cards, VPS instances,
  domains, insurance, documents, and a blank one. Columns are typed, and the
  type drives sorting, filtering and how a cell renders.
- **Two ways to express a due date.** Store the next one directly, or store the
  last renewal and a cycle and let it work the date out. Cycles run from weekly
  to three-yearly, plus lifetime and an arbitrary number of days — so a 181-day
  SIM keep-alive is an ordinary setting, not a special case.
- **Status values carry meaning.** Each one declares whether it counts as
  spending, whether it should remind you, and whether it belongs on the
  timeline.
- **Reminders and calendar.** Telegram bot and SMTP email on an N-days-ahead
  threshold plus a daily digest, de-duplicated across restarts and caught up
  after downtime; an ICS feed at `/calendar.ics` for calendar apps.
- **Money stays in its own currency.** Prices are recorded as entered and
  totalled per currency; conversion is a view you can turn on.
- **Backups run themselves.** A SQLite snapshot after 03:30 each night, 14 kept
  on a rolling basis, plus a JSONL export of every table that stays readable
  without Kalends around.

## Install

**Prebuilt binaries are Linux only.** Grab one from
[Releases](https://github.com/Lynthar/Kalends/releases):

```bash
tar xzf kalends-v0.1.0-x86_64-unknown-linux-gnu.tar.gz
KALENDS_DATA=./data TZ=Asia/Shanghai ./kalends-v0.1.0-x86_64-unknown-linux-gnu/kalends
```

There's an `aarch64` build for ARM boxes and NAS units, and a `musl` build for
old glibc or Alpine. `SHA256SUMS` ships alongside them.

**Docker** — the compose file builds locally; no image is published anywhere:

```bash
docker build -t kalends:local .
sudo chown -R 10001:10001 /path/to/appdata/kalends
docker compose -f deploy/compose.yaml up -d
```

**From source:**

```bash
cargo run
```

That serves `http://127.0.0.1:4180` with data in `./data/`. If the repository
lives on a network share, set `CARGO_TARGET_DIR` to somewhere local first —
cargo doesn't get along with SMB.

## Usage

```bash
KALENDS_DATA=./data KALENDS_ADDR=127.0.0.1:4180 TZ=Asia/Shanghai ./kalends
```

Two other modes:

```bash
kalends --health                                    # for a container healthcheck
kalends restore --from backups/snapshot-2026-08-25.db --to ./data-new
```

Day to day: add it to your phone's home screen and it behaves like an app; fill
in Telegram or SMTP under settings and send yourself a test notification; set an
ICS token and subscribe to `/calendar.ics?token=…` from your calendar.

## Configuration

Four environment variables, and everything else lives in the settings page.

| Variable | Default | Notes |
|---|---|---|
| `KALENDS_ADDR` | `127.0.0.1:4180` | The container image binds `0.0.0.0:4180` instead |
| `KALENDS_DATA` | `data` | `/data` in the container |
| `TZ` | — | **Set this.** Containers default to UTC and "today" ends up wrong |
| `RUST_LOG` | `info` | |

In the settings page: an optional PIN, the ICS token, a shared outbound proxy,
a display currency, Telegram and SMTP credentials, reminder thresholds and the
digest time.

## Limitations

- **Single user, by design.** No accounts, no permissions. The optional PIN keeps
  a curious housemate out and nothing more. Two browser tabs left open on stale
  data can overwrite each other.
- **Not meant to face the internet.** Put it behind Tailscale or a VPN rather
  than a public port and a PIN.
- **The database has to be on local disk.** SQLite locking over SMB or NFS isn't
  reliable enough to trust with your only copy.
- **The interface is Chinese only.** There's no i18n layer, so the UI, and the
  CLI output from `restore` and `--health`, are all in Chinese.
- **Search is a plain `LIKE`.** Fine for hundreds of rows; there's no full-text
  index and no virtual scrolling yet.

## Documentation

- [User guide](docs/user-guide.md) — Docker Compose, a Caddy reverse proxy
  example, running on bare metal, restoring, upgrades and rollback,
  troubleshooting notifications. Written in Chinese.

## License

GNU Affero General Public License v3.0 only — see [LICENSE](LICENSE).
Copyright (c) 2026 Lynthar.
