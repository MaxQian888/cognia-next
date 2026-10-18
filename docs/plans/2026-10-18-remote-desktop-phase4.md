# Remote desktop Phase 4: Selkies streaming for local Docker CUA (ADR-0234)

Phases 1–3 gave the local Docker CUA desktop one fenced control lease and an
RPC-polled viewer (one screenshot a second). Phase 4 adds an opt-in Selkies
stream for that desktop, so the user watches and works at 30 fps when the
image was built with it. The lease stays the authority: Selkies only ever
grants keyboard and mouse to the viewer that holds it.

Upstream facts (Selkies 2.0.0, commit `3ec56fb`, verified 2026-10-18):

- `pip install selkies==2.0.0` with `pixelflux==2.1.0` and `pcmflux==2.1.0`
  (manylinux_2_28 wheels for cp312 on x86_64 and aarch64). There is no
  GStreamer; `selkies` attaches to an existing X display via `DISPLAY`.
- One TCP port serves the page, `/api/*` and the data WebSocket
  (`/api/websockets`).
- Secure Mode is on when `SELKIES_MASTER_TOKEN` is set.
  `POST /api/tokens` with `Authorization: Bearer <master>` **replaces** the
  whole table `{token: {role: "controller"|"viewer", slot: null, mk_control?}}`.
  It answers `200 OK` before reconciliation finishes. A removed token's
  WebSocket closes with 4002, and a role change also closes it.
  `GET /api/sessions` lists live clients with their role, and
  `DELETE /api/sessions/{id}` disconnects one.
- `enable_collab=false` drops viewer input. Clipboard, file transfer,
  printing, gamepads, sharing links, command messages and the second screen
  are separate switches.
- The page reads `?token=`. The client uses WebCodecs `VideoDecoder` and falls
  back to JPEG without it. It requires a secure context, and loopback counts.
- The released `pixelflux` wheel bundles GPL x264/x265/FFmpeg, so a Selkies
  image must stay a local build. Cognia never publishes one.

## Decisions (settled with the user on 2026-10-18)

1. **A layered variant image, not a build argument on the main Dockerfile.**
   `image/selkies/Dockerfile` is `FROM cognia-cua-desktop:0.3.46-2` and is
   tagged `cognia-cua-desktop:0.3.46-2-selkies-2.0.0`, labelled
   `cognia.cua.selkies="2.0.0"`.
   - The default image and the managed desktop image are byte-identical to
     today, so recipe 7 and the managed release identity do not move.
   - The variant refuses `--managed`, so Selkies never enters a managed
     desktop (that would need an ADR-0233 amendment).
2. **Per-connection opt-in.** The sandbox connection form gets a Selkies
   switch. Turning it on shows the licence notice and sets that connection's
   image to the variant tag. Turning it off sets the image back to the
   built-in tag. The first start builds the image locally, building the base
   first if it is missing.
3. **Embedded with an iframe.** The Tauri CSP `frame-src` gains
   `http://127.0.0.1:*`. The viewer frames the Selkies page from the
   container's loopback-published port with `sandbox="allow-scripts
allow-same-origin"` and no referrer.
4. **H.264 software encoding with JPEG fallback.** Selkies runs with
   `--encoder=h264enc,jpeg --use-cpu=true`.

## Host (Rust, `cognia-automation`)

1. **Image.**
   - `lifecycle.rs` embeds the three variant files (`Dockerfile`,
     `selkies-startup.py`, `selkies-entrypoint.sh`).
   - `pinned_spec` builds the variant when its tag is missing: it ensures
     the built-in base exists, then runs `docker build --build-arg
BASE_IMAGE=<built-in tag>` with a 1200 s timeout.
   - It also reads the image's `cognia.cua.selkies` label into
     `SpawnSpec.stream`.
2. **Container.** When `stream` is set, `run_args` adds
   `-p 127.0.0.1:0:8080` and `--env COGNIA_SELKIES_MASTER_TOKEN`, name only.
   `create_with_private_token` passes a second random 64-hex value for it.
   `docker_stream_endpoint(container)` returns the published port and the
   master token, recovered from `docker inspect` like the auth token, or
   `None` when the container has no Selkies label.
3. **In the container** (`selkies-startup.py`, run as `cua` by the variant
   entrypoint):
   - Pops the master token.
   - Runs the stock `startup.main()` in-process, so the computer-server
     token handling is unchanged.
   - A thread waits for `:99`, then supervises `selkies` with an explicit
     environment (only `DISPLAY`, `HOME`, `PATH`, `XDG_RUNTIME_DIR`,
     `SELKIES_MASTER_TOKEN`). It restarts with backoff (at most 5 times) and
     kills the process group when the desktop exits.
   - Fixed flags:
     `--addr=0.0.0.0 --port=8080 --mode=websockets --enable-dual-mode=false
--wayland=false --encoder=h264enc,jpeg --use-cpu=true
--enable-resize=false --enable-collab=false --enable-basic-auth=false
--enable-https=false`.
   - Everything else that could move data or input is off: audio,
     microphone, webcam, gamepads, clipboard, file transfers, printing,
     command messages, sharing, extra players and the second screen.
   - The matching sidebar sections are hidden.
4. **Stream grants** (`cua_sandbox/stream.rs`), one per connection, under their
   own mutex, so opening a viewer never waits behind an agent action:
   - **Viewers.** At most 8 grants; the oldest is evicted. Each gets a fresh
     32-byte token with role `viewer`.
   - **Controller.** `claim(viewer, lease token, fence)` checks the lease
     under the desktop guard, mints a new controller token
     (`role: controller, mk_control: true`) and drops that viewer's old token.
   - **Every change POSTs the whole table.** One owner serializes them.
   - **Revocation order.** First POST the table without the controller. Then
     poll `/api/sessions` until no controller session remains (3 s). Next,
     DELETE any that are left and poll again (2 s). Only then is control
     considered given up.
   - **Unconfirmed revocation.** If the controller session is still there,
     the grant is marked unconfirmed. `release_control` refuses and keeps the
     lease, and every agent admission retries the revoke and refuses until it
     is confirmed.
   - **Lease expiry.** An expired lease that left a controller grant behind
     is revoked by the next agent admission before the agent runs, and by
     `acquire_control`.
   - **Stale tables.** Lifecycle changes (create, start, resume, suspend,
     stop, delete, app exit) forget the in-process grants. The next connect
     (`start`, `resume`, a cold `client()`) POSTs `{}`, so a table left over
     from before an app restart never outlives it.
5. **Commands** (Tauri, `client` target, `internal` transport, like the
   other `cua_sandbox_desktop_*`):
   - `cua_sandbox_desktop_stream_open { connectionId }` returns
     `{ viewerId, url, role: "viewer" }`. If the container has no Selkies it
     refuses with `sandbox_stream_unavailable`.
   - `cua_sandbox_desktop_stream_claim { connectionId, viewerId, token, fence }`
     returns `{ viewerId, url, role: "controller" }`.
   - `cua_sandbox_desktop_stream_close { connectionId, viewerId }`.
6. **Audit.** New kinds `remote_desktop.stream.open`, `.claim`, `.revoke`,
   `.revoke_unconfirmed` go in the allowlist. Rows record the role only,
   never tokens or URLs. Input sent through Selkies is not seen by the Host,
   so per-input audit rows exist only for the polled path. The docs say so.

## Client

- `sandboxClient.streamOpen/streamClaim/streamClose`.
- `useSandboxDesktopStream(connectionId, enabled)` owns the viewer grant:
  - It opens one on mount; `sandbox_stream_unavailable` means no stream.
  - `claim(lease)` after control is acquired; `reopen()` after release or
    loss.
  - It closes the grant on unmount.
- `useSandboxDesktop` gains a slow poll (5 s) while streaming and reports
  lease changes through `onLeaseChange`. Window blur no longer releases control
  while focus is inside the stream frame.
- `SandboxDesktopViewer` renders the iframe when a stream URL exists. It
  remounts the iframe when the URL changes; a role change closes Selkies'
  socket anyway. It hides the polled-input tools while streaming. Without a
  stream, nothing changes.
- The connection form gets the Selkies switch and licence notice. The help
  text says an existing sandbox must be recreated to change its image.

## Out of scope

Streaming for paired phones and browsers: these commands stay `internal`
like every local sandbox command. Hardware encoders, audio, a non-GPL
pixelflux build, and Selkies in managed desktops.

## Verification

- Rust tests for the grant table, claim, the revoke order with confirm,
  DELETE fallback and unconfirmed refusal, agent admission revoking a grant
  left by an expired lease, the variant build arguments, `run_args` with the
  stream port, and master-token parsing.
- Python tests for `selkies-startup.py`: the fixed flags, the explicit child
  environment and the master-token checks.
- Jest for the client wrappers, the stream hook, the viewer and the
  connection form.
- `pnpm companion-api:check`, the command gates, `lint:i18n` and
  `i18n:build:check`.
- Not covered by these tests: a real Docker build of the variant on x86_64
  and arm64, a 1280×800 FPS/CPU baseline, and whether macOS WKWebView allows
  the loopback iframe. These are offered as a smoke after the phase.

## As built

- **Variant entrypoint.** The variant has its own entrypoint
  (`/usr/local/bin/cognia-desktop-selkies`). It refuses every argument, so
  `--managed` cannot reach it. It runs `selkies-startup.py` as `cua` with
  `python3 -I`, and that script loads the stock `startup.py` in-process.
- **Image detection.** `pinned_spec` reads the label with one `docker image
inspect` format: `{{.Id}}|<cognia.cua.selkies label>`. Only a labelled image
  publishes the stream port and receives a master token. The default image is
  unaffected.
- **Commands stay internal.** The three `cua_sandbox_desktop_stream_*`
  commands are `client`/`internal` in `protocol/companion-commands.json` and
  local-only in `headless-command-dispositions.json`. Paired phones and
  browsers do not stream.
- **Host HTTP.** The Host calls Selkies through
  `cognia_net::proxy_config::managed_client` with the sensitive Bearer header.
  It reads at most 256 KiB of `/api/sessions`.
- **Settling points.** `release_control` and every agent admission
  (`agent_guard`, after `require_agent`) settle the stream first. "Settle"
  means retrying a pending revoke, or revoking a controller grant whose lease
  is no longer current. While it is unconfirmed, both refuse.
- **Known limits.**
  - Input sent through Selkies does not pass the Host, so it has no
    per-input audit rows. Lease and grant rows still exist.
  - The master token protects the stream from other local processes. It is
    not a boundary against code inside the container, which already runs as
    the same user as Selkies.
  - Selkies may set its own cookies as `SameSite=Strict`. Inside the
    `127.0.0.1` iframe they are third-party, so the page must work from
    `?token=` alone. Whether WKWebView loads the frame at all is unverified.
    If it does not, the frame stays blank, and the sandbox must be recreated
    on the default image to get polling back. Both are part of the smoke.
