# Changelog

Release notes are taken from this file verbatim — each `## vX.Y.Z` section becomes that release's body.

## v0.3.1

**Looks different**: in a narrow window, a table showing a date or number column now scrolls sideways instead of squeezing dates down to "2026-…". On touch screens the row checkbox, drag handle and ⤢ are always visible and large enough to tap. Scrolling no longer closes the cell editor, so rotating a phone keeps what you typed. Renewing something with no cycle, like an ID document, opens its form at the due date.

**Errors**: an unreadable table is a 500, not a 404, and a 500's `error` carries the full cause. Migration, startup, backup and restore failures name the step, version or path.

**Fixed**: the PIN is asked for once on first load, and a wrong one is reported as such. Enter that confirms an input-method candidate no longer saves half-typed text. Pasted phone numbers with full-width digits, dots or invisible marks are accepted. With a display currency set, prices sort and filter by the converted amount. The icon fetcher's 45-second limit now covers redirects, and `--health` ignores proxy variables and times out after 4 seconds.

**Docs**: the glibc builds need glibc 2.34 or newer; on older ARM systems use Docker or build from source.

**Upgrading**: no schema change.

## v0.3.0

**Security**: the favicon fetcher's private-address filter now reads NAT64 addresses by the IPv4 they carry and matches `.local` / `.localhost` in any case; the calendar token is compared in constant time; rustls is past RUSTSEC-2026-0285, and a release now fails on any known advisory. The nightly JSONL export masks channel secrets and proxy passwords. The database and its snapshots still hold them in plain text, so protect those files (see `SECURITY.md`).

**Reminders**: a failed delivery backs off and gives up after five attempts, and an SMTP session is capped at one minute. Adding a looser threshold no longer re-sends what was already sent. Entries whose status turns reminders off (such as Ending) keep their calendar event but lose the alarm. "Send test" tries what is in the form and saves nothing.

**Data**: item and field ids are never reused, so a new column cannot pick up a deleted column's values. Every write follows one set of rules: a cycle outside the supported list is refused with the list in the error, a status that differs from the vocabulary only in case takes the vocabulary's spelling, and column values must match the column type (values already stored are left as they are). The item form saves only what you changed, a malformed stored value no longer breaks the overview or the calendar, and saves and refreshes in one tab run in order.

**Home page**: alongside entries with no computable due date, it names entries whose status keeps them off the timeline and entries whose status is not in their collection's vocabulary. Renewing the same entry twice in a day asks first.

**Command line and container**: unknown arguments exit 2 instead of starting the server (and migrating the database); `--version` is new. `restore` folds a `-wal` file next to the snapshot into the copy. `/api/health` reads every data table, not just three, and answers without the PIN, though without it you get only the `ok` field, so the container healthcheck notices a broken database even with a PIN set; `--health` now wants a 200. An unknown `TZ`, or none at all on a UTC host, is logged as a warning. A panic ends the process, so a supervisor such as compose's `restart:` can bring it back. Building the image needs BuildKit (the default since Docker 23); building from source needs Rust 1.91.

**Upgrading**: a snapshot lands in `backups/` before the schema changes (one new table records the highest ids handed out). API clients that send a cycle outside the list, or a column value of the wrong type, now get a 400.

## v0.2.0

There is now a [live demo](https://lynthar.github.io/Kalends/demo/) — read-only, synthetic data — if you want a look before installing.

**Fixed**: a failed settings read no longer passes for "not set". The notifier warns instead of silently skipping a run, exchange-rate and logo fetches refuse to go out when the proxy setting cannot be read, deleting an entry rolls back instead of orphaning its logo, and the settings form will not save over a channel config it could not read. A `days` cycle must carry a day count.

**Removed**: `KALENDS_MODULES`, `/config.js` and the TMDB key setting. Outbound traffic is down to exchange rates, favicons and your notification channels.

**Upgrading from v0.1.x**: a snapshot lands in `backups/` before the schema changes. The media library that used to sit alongside is gone: if you still have media entries, this version refuses to start and says so. `covers/` can go afterwards.

## v0.1.0

First tagged build. Kalends is a self-hosted ledger for things that renew: subscriptions, SIM keep-alives, VPS boxes, and whatever else you care to define. A media library sits alongside it. The code has been running as my own ledger for a few months and did not change for the release — it just has binaries now.

Take `x86_64-unknown-linux-gnu` for an ordinary server, `aarch64` for ARM boxes and NAS units, or the static `musl` build if your glibc is old or you are on Alpine. Check what you downloaded against `SHA256SUMS`.

Unpack it, point `KALENDS_DATA` at a directory on local disk, and open http://127.0.0.1:4180. Keep that directory off SMB and NFS; their locking is not reliable enough for a ledger. Compose file, reverse proxy, backups and restore are in [the user guide](https://github.com/Lynthar/Kalends/blob/main/docs/user-guide.md).

### Before you trust it with data

Single user by design: no accounts, no permissions, and the optional PIN stops a curious housemate and nothing more. Two browser tabs left open on stale data can overwrite each other. The notification path has never run against a live channel outside my own instance, and nobody has checked the touch targets on a real phone.
