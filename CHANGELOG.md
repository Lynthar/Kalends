# Changelog

Release notes are taken from this file verbatim — each `## vX.Y.Z` section becomes that release's body.

## v0.1.0

First public release. Kalends has been running as the author's daily ledger for a few months; this is the first tagged build with prebuilt binaries.

**What you get**

- Renewal tracking for anything with a next date — subscriptions, SIM keep-alives, VPS boxes ship as ready-made collections, and you can build your own from a template or from scratch.
- Notion-style tables: typed columns, in-place editing, per-collection field sets, per-device sort/filter/width.
- Reminders over Telegram and SMTP with N-days-before thresholds and a daily digest, deduplicated and catching up on downtime; plus an ICS feed to subscribe from a phone calendar.
- Media library for films, series, anime and games, with TMDB lookup and a poster wall.
- Prices kept in their original currency; status values carry their own spend/alert/timeline semantics.
- Nightly SQLite snapshots and a plain-text JSONL dump, `kalends restore` to rebuild a verified data directory from a snapshot, and an automatic snapshot before any database migration.
- One binary, one SQLite file, no account, no telemetry. Optional PIN gate.

**Requirements**

Linux x86_64 or aarch64. The `musl` build is statically linked and runs on older distributions and Alpine. Keep the SQLite file on local disk — network filesystem locking is not reliable enough for a ledger.

**Known limits**

Single user by design: there are no accounts and no per-user data. Two stale browser tabs can overwrite each other. Touch-target sizes have not been verified on real mobile devices, and the notification path has not yet been exercised against a live channel by anyone but the author.
