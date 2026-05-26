# signaling-worker

Cloudflare Worker + Durable Objects build of the WebRTC signaling rendezvous
(ADR-0021). It is the Cloudflare-native counterpart to the native axum server
in `../` — both speak the **same wire protocol** (the shared `cognia-signaling-core`
crate), so the existing mobile (`lib/signaling/client.ts`) and desktop
(`src-tauri/.../signaling/client.rs`) clients work against either backend.

## How it maps

- The Worker (`src/lib.rs`) is a stateless router. It reads `?rid=<rendezvousId>`
  from the upgrade URL and forwards the WebSocket to a per-room Durable Object
  via `env.ROOM.idFromName(rid)`.
- `RoomDurableObject` (`src/room.rs`) is one instance per room — the platform's
  sharding replaces the axum server's in-process `RoomRegistry`. It accepts
  hibernatable WebSockets and relays opaque payloads between the room's peers.
- Per-connection state (role, join time, rate-limit bucket) rides on each
  socket's serialized attachment, so it survives Durable Object hibernation.

## Prerequisites

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build      # produces build/worker/shim.mjs
npm i -g wrangler               # or use `pnpm dlx wrangler`
wrangler login
```

## Develop

```bash
worker-build --release          # build the wasm + JS shim
wrangler dev                    # serves http://127.0.0.1:8787
```

Smoke-test a running instance (Node 22+, no deps) with two real clients:

```bash
node tests/integration.mjs                  # against wrangler dev
SIGNALING_URL=wss://<host> node tests/integration.mjs   # against a deployment
```

## Deploy

```bash
wrangler deploy                 # first deploy applies the v1 DO migration
```

### Choosing the domain

The signaling hostname is configurable in **one** place per side, kept in sync:

- **App default** — `DEFAULT_SIGNALING_URL` in `lib/signaling/types.ts` reads
  the `NEXT_PUBLIC_SIGNALING_URL` build var, falling back to
  `wss://signaling.cognia.cn/v1/signaling`. Set the env var at `pnpm build`
  time to point every shell (browser/Tauri/Capacitor) and the Rust desktop
  peer (via `option_env!`) at your domain. Users can still override per-install
  at runtime in Settings → Companion → WebRTC.
- **Worker** — the `routes` line in `wrangler.toml` (defaults to
  `signaling.cognia.cn`). Change it to your hostname.

`wrangler.toml` claims its custom domain on `wrangler deploy`; this REQUIRES the
matching zone (e.g. `cognia.cn`) to be active on the Cloudflare account. The
Worker is also reachable at its `*.workers.dev` subdomain — to deploy without a
custom domain, comment out the `routes` line and point the app's signaling URL
at `cognia-signaling.<account>.workers.dev/v1/signaling` instead.

## Notes

- **Free plan**: Durable Objects are available on the Workers Free plan when
  SQLite-backed (`new_sqlite_classes` in `wrangler.toml`).
- **Per-IP limiting**: the axum server's `ip_limits.rs` (50/IP) is _not_
  reimplemented here — configure a Cloudflare Rate Limiting rule on the
  `/v1/signaling` route instead.
- **Metrics**: key events are logged via `console_log!` (visible in
  `wrangler tail` / the dashboard). To replace the axum server's Prometheus
  `/metrics`, uncomment the Analytics Engine binding in `wrangler.toml`.
