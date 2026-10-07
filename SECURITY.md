# Security

## Reporting

Report vulnerabilities privately through GitHub's [security advisories](https://github.com/Lynthar/Kalends/security/advisories/new). This is a single-maintainer hobby project — expect a reply in days, not hours.

## Supported versions

The latest release only. There are no backports; security fixes ship as their own patch release.

## Threat model

Kalends is built for **one person on a private network**. It has no accounts, no roles, and no per-user data separation. Anyone who can reach the port can read and write the whole ledger.

The optional PIN is a thin door, not a public-internet defence: it is a plain equality check with no rate limiting and no backoff, so a short PIN falls to a script on a network that can reach the host. It exists to stop the other devices on your LAN from casually opening the app.

**Do not expose Kalends to the public internet.** Reach it over a private network (Tailscale, WireGuard) instead. If you put a reverse proxy in front of it anyway, add authentication and the usual security headers at that layer — the app sets none of its own.

## What the app does on its own

Nothing leaves the machine unprompted. Outbound traffic happens only when you ask for it: exchange-rate refreshes, favicon fetches, and the notification channels you configure. There is no telemetry and no update check.

Server-side fetches of user-supplied URLs (favicons) are blocked from reaching private address space — literal addresses, DNS resolution results, and every redirect hop are each re-checked. All outbound requests carry timeouts and capped response bodies.

Secrets (bot tokens, SMTP passwords, proxy credentials) live in the SQLite file unencrypted, as does everything else, and so do the daily snapshots in `backups/`. The settings API does not read channel secrets back in plain text, and the JSONL export in `export/` masks them along with proxy passwords; the ICS token and the PIN are exported as they are. Anyone with the database file or a snapshot has every secret. Protect those files, not the field.
