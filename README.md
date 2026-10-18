<div align="center">

<img src="assets/icon.svg" alt="Kalends" width="96">

# Kalends

[![license](https://img.shields.io/github/license/Lynthar/Kalends)](LICENSE)
[![release](https://img.shields.io/github/v/release/Lynthar/Kalends)](https://github.com/Lynthar/Kalends/releases)

**[Live demo](https://lynthar.github.io/Kalends/demo/)** (read-only, synthetic data) ·
[Project page](https://lynthar.github.io/Kalends/)

</div>

Self-hosted subscription renewal tracker — subscriptions, SIM keep-alives, VPS boxes, anything with a next date. One Rust binary, one SQLite file.

English | [简体中文](README.zh-CN.md)

Everything with a next date goes on one timeline: in-app purchases, phone plans,
VPS boxes, domains, insurance, documents that expire.

I built it to replace a Notion database. I had been tracking these subscriptions
in Notion because that is where I already lived, but it has a few drawbacks: it
only works online, some of what goes in is private and I would rather not have it
leak, and date arithmetic and parts of the display are limited and awkward. So I
made my own.
The tool keeps the same shape for the data — libraries with typed columns — but
it comes out as one binary plus one SQLite file, no accounts, nothing phoning
home except the notifications you set up yourself. It can run on a NAS for
months without attention. You can also put it on a VPS, if there is nothing
private in the library.

## Features

- **Seven library templates** — subscriptions, SIM cards, VPS instances,
  domains, insurance, documents, and a blank one. Columns are typed, and the
  type drives sorting, filtering and how a cell renders.
- **One due date per item.** You write the next due date; "last renewed" (the
  start of the current period) and "days left" are worked out from it. Cycles
  run from weekly to three-yearly, plus lifetime and an arbitrary number of days
  — so a 181-day SIM keep-alive is an ordinary setting, not a special case. A
  billing day on the 29th–31st does not drift: a short month clamps to its last
  day and the next month comes back to the original day.
- **Renewing is one click.** Marking an item renewed moves its date forward and
  writes a ledger entry; if you log it late, set the day you actually paid. Each
  library decides where the next period starts: the billing schedule (a VPS
  billed on the 15th stays on the 15th) or the payment day (a SIM keep-alive
  window restarts when you top up). Items the provider charges automatically
  can be set to auto-renew: the day after a billing date, Kalends books that
  period in the ledger, marked as automatic, and moves on to the next one, as
  long as the status counts as spending. Periods already overdue when you
  switch it on still need one manual renewal, and auto-renewing items show up
  in the daily digest instead of getting reminders of their own.
- **Status values carry meaning.** Each one declares whether it counts as
  spending, whether it should remind you, and whether it belongs on the
  timeline.
- **Reminders and calendar.** Telegram bot and SMTP email on an N-days-ahead
  threshold plus a daily digest, de-duplicated across restarts and caught up
  after downtime; an ICS feed at `/calendar.ics` for calendar apps.
- **Amounts are recorded in their original currency.** Prices are stored as
  entered and totalled per currency; conversion is a view you can turn on.
- **Backups run automatically.** A SQLite snapshot after 03:30 each night, 14
  kept on a rolling basis, plus a JSONL export of every table that can be read
  without Kalends installed.

## Install

**Prebuilt binaries are Linux only.** Grab one from
[Releases](https://github.com/Lynthar/Kalends/releases):

```bash
# <version> is the release tag, e.g. v0.2.0
tar xzf kalends-<version>-x86_64-unknown-linux-gnu.tar.gz
KALENDS_DATA=./data TZ=Asia/Shanghai ./kalends-<version>-x86_64-unknown-linux-gnu/kalends
```

There's an `aarch64` build for ARM boxes and NAS units. Both glibc builds need
glibc 2.34 or newer (Debian 12, Ubuntu 22.04, RHEL 9 and later); on older x86-64
systems or Alpine use the static `musl` build, and on older ARM systems use
Docker or build from source. `SHA256SUMS` ships alongside them.

**Docker** — the compose file builds locally (BuildKit required, the default since Docker 23); no image is published anywhere:

```bash
docker build -t kalends:local .
sudo mkdir -p /path/to/appdata/kalends
sudo chown -R 10001:10001 /path/to/appdata/kalends
docker compose -f deploy/compose.yaml up -d
```

**From source** (Rust 1.91 or newer):

```bash
cargo run
```

That serves `http://127.0.0.1:4180` with data written to `./data/`. If the
repository lives on a network share, set `CARGO_TARGET_DIR` to somewhere local
first — cargo has problems on SMB.

## Usage

```bash
KALENDS_DATA=./data KALENDS_ADDR=127.0.0.1:4180 TZ=Asia/Shanghai ./kalends
```

Other modes (any other argument is refused with exit code 2, without touching the data directory):

```bash
kalends --version
kalends --health                                    # for a container healthcheck
kalends restore --from /path/to/data/backups/snapshot-2026-08-25.db --to /path/to/data-restored
```

Day to day: add it to your phone's home screen and it behaves like an app; fill
in Telegram or SMTP under settings and send yourself a test notification; copy the
calendar link from the settings page and subscribe to it from your calendar app.

## Configuration

Four environment variables, and everything else lives in the settings page.

| Variable | Default | Notes |
|---|---|---|
| `KALENDS_ADDR` | `127.0.0.1:4180` | The container image binds `0.0.0.0:4180` instead |
| `KALENDS_DATA` | `data` | `/data` in the container |
| `TZ` | — | **Set this.** Containers default to UTC and "today" ends up wrong |
| `RUST_LOG` | `info` | |

In the settings page: an optional PIN, the calendar link, a shared outbound proxy,
a display currency, Telegram and SMTP credentials, reminder thresholds and the
digest time.

Outbound HTTP requests also honour `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and
`NO_PROXY` from the environment, unless the settings page gives them a proxy:
Telegram has its own proxy field, while exchange rates and icon fetching share
the outbound one. A proxy set there replaces the environment ones for those
requests. SMTP always connects directly.

## Limitations

- **Single user, deliberately.** No accounts, no permissions. The optional PIN
  just keeps a curious housemate out. Two browser tabs left open on stale data
  can overwrite each other.
- **The database has to be on local disk.** SQLite locking over SMB or NFS isn't
  reliable; don't put your only copy of the data there.
- **The interface is Chinese only, for now.** There's no i18n layer, so the UI
  and the output of `restore` are in Chinese.
- **Everything loads up front.** Search is a substring match in the browser over
  names, notes and custom columns, and every entry is drawn at once, with no
  pagination or virtual scrolling. A personal ledger won't notice; tens of
  thousands of entries will.

## Documentation

- [User guide](docs/user-guide.md) — deploying (Docker Compose, release
  binaries, source), reverse proxy and remote access, backup and restore,
  upgrades and rollback, tracking down a missing reminder. Written in Chinese.

## License

GNU Affero General Public License v3.0 only — see [LICENSE](LICENSE).
Copyright (c) 2026 Lynthar.
