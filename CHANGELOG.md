# Changelog

Release notes are taken from this file verbatim — each `## vX.Y.Z` section becomes that release's body.

## v0.1.0

First tagged build. Kalends is a self-hosted ledger for things that renew: subscriptions, SIM keep-alives, VPS boxes, and whatever else you care to define. A media library sits alongside it. The code has been running as my own ledger for a few months and did not change for the release — it just has binaries now.

Take `x86_64-unknown-linux-gnu` for an ordinary server, `aarch64` for ARM boxes and NAS units, or the static `musl` build if your glibc is old or you are on Alpine. Check what you downloaded against `SHA256SUMS`.

Unpack it, point `KALENDS_DATA` at a directory on local disk, and open http://127.0.0.1:4180. Keep that directory off SMB and NFS; their locking is not reliable enough for a ledger. Compose file, reverse proxy, backups and restore are in [the user guide](https://github.com/Lynthar/Kalends/blob/main/docs/user-guide.md).

### Before you trust it with data

Single user by design: no accounts, no permissions, and the optional PIN stops a curious housemate and nothing more. Two browser tabs left open on stale data can overwrite each other. The notification path has never run against a live channel outside my own instance, and nobody has checked the touch targets on a real phone.
