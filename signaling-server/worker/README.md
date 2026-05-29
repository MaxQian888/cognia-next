# signaling-worker

Cloudflare Worker + Durable Objects build of the WebRTC signaling rendezvous
(ADR-0021). It is the Cloudflare-native counterpart to the native axum server
in `../` — both speak the **same wire protocol** (the shared `cognia-signaling-core`
crate), so the existing mobile (`lib/signaling/client.ts`) and desktop
(`src-tauri/.../signaling/client.rs`) clients work against either backend.

## How it maps

- The Worker (`src/lib.rs`) is a stateless router. It checks the `Origin`
  allowlist, reads `?rid=<rendezvousId>` from the upgrade URL, and forwards the
  WebSocket to a per-room Durable Object via `env.ROOM.idFromName(rid)`.
- `RoomDurableObject` (`src/room.rs`) is one instance per room — the platform's
  sharding replaces the axum server's in-process `RoomRegistry`. It accepts
  hibernatable WebSockets and relays opaque payloads between the room's peers.
- Per-connection state (role, join time, rate-limit bucket, source IP, metric
  sample counter) rides on each socket's serialized attachment, so it survives
  Durable Object hibernation.

### Parity with the axum server

Room admission and the origin check call the **same**
`cognia-signaling-core::policy` functions the axum server uses, so the two
deployments can't drift:

- **Room cap / role cardinality** — `evaluate_subscribe` rejects a `Subscribe`
  past `SIGNALING_MAX_PEERS_PER_ROOM` (`room_full`) or a second desktop
  (`role_taken`). The socket stays open so the client can surface the reason.
- **Subscribed-only fan-out** — relays and `peerJoined`/`peerLeft` go only to
  peers that have actually `Subscribe`d. A socket that connects but never
  subscribes receives nothing, so it cannot silently eavesdrop a room's SDP/ICE
  by knowing the `rid` (the relay payload is HMAC-signed but not encrypted).
- **Origin allowlist** — `SIGNALING_ALLOWED_ORIGINS` (empty = allow all; a
  missing `Origin`, as native clients send, is always allowed). A present,
  unlisted browser `Origin` gets `403`.
- **Per-connection rate limit** — the shared 20-token / 10-per-sec bucket;
  `rate_limited` closes the socket, `frame_too_large` (8 KiB soft cap) does not.
- **Binary frames** are rejected with `binary_not_supported`.
- **Per-IP cap (in-DO)** — `SIGNALING_MAX_CONN_PER_IP_PER_ROOM` bounds how many
  sockets one `cf-connecting-ip` may hold in a single room; the overflow upgrade
  gets `429`. (See the global edge rule below.)

## Configuration (`wrangler.toml` `[vars]`)

| Var                                  | Default | Meaning                                                                                                                            |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNALING_MAX_PEERS_PER_ROOM`       | `4`     | Max peers per room (slack above 1 desktop + 1 mobile for reconnect overlap).                                                       |
| `SIGNALING_MAX_DESKTOPS`             | `1`     | Max desktop peers per room.                                                                                                        |
| `SIGNALING_MAX_CONN_PER_IP_PER_ROOM` | `4`     | Max sockets one IP may hold in one room (needs `cf-connecting-ip`, i.e. a real edge — a no-op under local `wrangler dev`).         |
| `SIGNALING_ALLOWED_ORIGINS`          | `""`    | Comma-separated browser Origin allowlist; empty = allow all. e.g. `https://app.cognia.cn,capacitor://localhost,https://localhost`. |
| `AE_SAMPLE_N`                        | `10`    | 1-in-N Analytics Engine sampling for hot events.                                                                                   |

These names mirror the axum server's env vars, so both backends are tuned the
same way.

## Prerequisites

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build      # produces build/worker/shim.mjs
npm i -g wrangler               # or use `npx wrangler` / `pnpm dlx wrangler`
wrangler login                  # interactive (opens a browser)
```

## Develop

```bash
worker-build --release          # build the wasm + JS shim
wrangler dev                    # serves http://127.0.0.1:8787
```

Smoke-test a running instance (Node 22+, no deps) with real WS clients —
covers subscribe/relay, the subscribed-only fan-out (eavesdrop) guarantee,
`frame_too_large`, ping/pong, `binary_not_supported`, `role_taken`, and the
room cap / per-IP cap:

```bash
node tests/integration.mjs                                  # against wrangler dev
SIGNALING_URL=wss://signaling.cognia.cn node tests/integration.mjs   # against a deployment
```

Note: under local `wrangler dev` there is no `cf-connecting-ip`, so the per-IP
cap is a no-op and the room's 5th subscriber is rejected with `room_full`;
against a real edge the per-IP cap refuses that 5th **upgrade** first when all
connections share one IP. The test accepts either outcome.

## Deploy

```bash
wrangler deploy                 # first deploy applies the v1 DO migration
curl https://<host>/healthz     # → {"ok":true,"version":"...","backend":"worker"}
```

**First time on a fresh account:** if you've never opened Workers, deploy fails
with `code 10063` ("you need a workers.dev subdomain"). Open the Cloudflare
dashboard → **Workers & Pages** once to register a `<name>.workers.dev`
subdomain, then re-run `wrangler deploy`.

### Domain — and why a custom domain is required for mainland China

The signaling hostname is configured in **one** place per side, kept in sync:

- **App default** — `DEFAULT_SIGNALING_URL` in `lib/signaling/types.ts` reads
  the `NEXT_PUBLIC_SIGNALING_URL` build var, falling back to
  `wss://signaling.cognia.cn/v1/signaling`. Set the env var at `pnpm build`
  time to point every shell (browser/Tauri/Capacitor) and the Rust desktop
  peer (via `option_env!`) at your domain. Users can override per-install at
  runtime in Settings → Companion → WebRTC.
- **Worker** — the top-level `routes` line in `wrangler.toml` (binds
  `signaling.cognia.cn` as a custom domain). It **must** stay above the
  `[vars]` table — a `routes` key placed under `[vars]` is parsed as an env var
  `vars.routes`, not a deploy trigger, and the custom domain silently won't bind.

> **`*.workers.dev` is SNI-blocked from mainland China** — the GFW resets the
> TLS handshake (you'll see `SEC_E_ILLEGAL_MESSAGE` / a connection reset at
> ~0.3 s while `api.cloudflare.com` and `www.cloudflare.com` stay reachable).
> So the free `workers.dev` URL is **not usable by CN clients**. Bind a custom
> domain on a zone you control instead — it uses your own SNI and is not
> blocked the same way. Custom domains for Workers are available on the **free
> plan**.

`wrangler deploy` provisions the custom domain's cert + route automatically;
this REQUIRES the matching zone (e.g. `cognia.cn`) to be active on the same
Cloudflare account. To deploy without a custom domain (non-CN / testing only),
comment out `routes` and use `cognia-signaling.<account>.workers.dev`.

### Global per-IP rate limiting (edge)

The in-DO cap only sees one room. For cross-room flooding from a single IP, add
a Cloudflare **Rate Limiting rule** (dashboard → Security → WAF → Rate limiting
rules) on this Worker — this is the analogue of the axum server's `ip_limits.rs`
(50/IP process-wide):

- Match: URI Path equals `/v1/signaling`
- Rate: 60 requests per 1 minute, counting by IP
- Action: Block (or Managed Challenge)

## Notes

- **Free plan**: Durable Objects work on the Workers Free plan when
  SQLite-backed (`new_sqlite_classes` in `wrangler.toml`).
- **Metrics / Analytics Engine**: the DO writes one sampled data point per
  event (`record`): `blob1` = event, `blob2` = role, `double1` = sample weight
  (query with `SUM(double1)`, **not** `COUNT(*)`, because hot events are 1-in-N
  sampled), `double2` = relay fanout. **Analytics Engine requires the Workers
  Paid plan**, so the `[[analytics_engine_datasets]]` binding ships commented
  out — `record()` no-ops without it and the relay is unaffected. Uncomment
  after upgrading to Paid. Either way, key events are also logged via
  `console_log!` (visible in `wrangler tail`).
- **Health**: `GET /healthz` → `{ "ok": true, "version": ..., "backend":
"worker" }`. Fleet-wide room/peer counts aren't available here (state lives in
  per-rid DOs with no cross-DO view) — use the Analytics Engine SQL API.
