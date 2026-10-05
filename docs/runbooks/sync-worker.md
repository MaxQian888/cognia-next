# Runbook — Account sync Worker (ADR-0215 phase 2)

Incident and maintenance steps for `cognia-sync` (`sync.cognia.cn`), which
holds each account's device registry, sealed epoch keys and enrollment
requests. Provisioning and deployment live in
[`services/sync-server/README.md`](../../services/sync-server/README.md).

The server holds no key and no name in the clear. Nothing here can recover a
person's data or enroll a device for them, by design.

## Every request answers 401 `unauthorized`

1. `wrangler tail cognia-sync` (add `--env staging`) while a client retries.
2. If tokens fail across the board, the JWKS fetch is failing. Check that the `IDENTITY` binding points at this environment's identity Worker, and that `https://id.cognia.cn/api/auth/jwks` answers.
3. If only some people fail, compare their token's `iss` and `aud` with `ISSUER` and `SYNC_AUDIENCE`. A staging token sent to production, or the reverse, is refused on purpose.

## Every request answers 503 `server_misconfigured`

Read `[sync] configuration error: …` in `wrangler tail`. Fix `ISSUER`, `SYNC_AUDIENCE` or `WEB_ORIGINS` in `wrangler.toml` and redeploy.

## A device keeps getting 401 `clock_skew` or `bad_proof`

- **`clock_skew`.** The device's clock is more than 120 s off and it did not correct from `Cognia-Server-Time`. Ask for the app version; older builds without the correction must update.
- **`bad_proof`.** The proof was signed for another request, or by a key the registry does not hold for that device. A device that lost its keys (reinstall, profile reset) must enroll again. Another device then revokes the old entry.

## A person lost every device

Their sync recovery key adds a new device; nothing on the server can. Without the recovery key the space cannot be opened. They can delete their account, or ask support to purge the space (below), and start a new space from a device.

## Purge one space

There is no HTTP route for this, on purpose. A space is deleted with its account: follow "A person asks to delete their account outside the app" in the [identity runbook](./identity-worker.md). The hourly purge deletes the sync space first, through the identity Worker's `SYNC_ADMIN` binding, and only then the identity.

## A purge keeps failing

The identity Worker logs `[identity] purged N account(s); M failed` with the reason. A failed purge stays pending and retries hourly.

- `SYNC_ADMIN` errors mean the sync Worker is unreachable or was deployed without the `SyncAdmin` entrypoint. Redeploy `cognia-sync`, then wait for the next run.

## A space reports `500 internal_error`

The space could not fold its own registry, so storage is corrupt. Never edit rows by hand. Capture `wrangler tail` output and escalate. The person's devices keep their pins and refuse anything that does not extend what they verified, so they cannot be misled while this is investigated.
