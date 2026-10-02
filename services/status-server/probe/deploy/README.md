# External status probe and read-only mirror: runbook

`cognia-status-probe` is one bundled Node file (`dist/cognia-status-probe.mjs`, Node ≥ 22, no npm install at runtime) with two commands:

| Command  | Does                                                                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`    | Every UTC minute: `GET /healthz`, a full authenticated signal + explicit `lane: "data"` relay run in a throwaway room, and the monitoring-plane checks; signs each batch and POSTs it to the status API, with a disk spool |
| `mirror` | Every 5 min copies the primary's public snapshots (24h/7d/30d/90d) and feeds; serves the exported status page read-only with `mode: "mirror"`                                                                              |

Plan: `docs/plans/2026-10-02-signaling-public-status-implementation.md` §4, §12, §13.

## 1. Host and independence requirements

The external probe is the **reference witness**, and the mirror is the fallback when Cloudflare is down. Both claims hold only if the host is independent of Cloudflare:

- Use a provider that is not Cloudflare (a VPS from Hetzner, OVH, AWS Lightsail, Alibaba Cloud and similar). Record the provider and the real city/region. That metadata goes into the registry at enrollment and is what the public page shows. Do not claim regions you do not run.
- The mirror hostname (for example `status-mirror.cognia.example`) must resolve through **DNS that Cloudflare does not proxy**. Use a different DNS provider, or at the very least a grey-cloud record. A second hostname behind the same Cloudflare proxy does not count.
- Two runners at one provider are not two independent providers. This setup is one external witness.
- Keep time synchronised (`chrony`/`systemd-timesyncd`). Ingestion signatures carry a timestamp that must be within ±120 s, and runs are slotted by UTC minute.
- Network: outbound TCP 443 only for the probe. The mirror also needs inbound 80/443, which Caddy terminates. The probe itself listens on nothing.

Base install (Debian/Ubuntu):

```bash
sudo apt-get install -y nodejs   # Node 22 or later. Use NodeSource or the distro backport if the distro ships an older version
node --version                   # must print v22.x or newer
sudo apt-get install -y caddy    # mirror host only
timedatectl show -p NTPSynchronized   # must be yes
```

## 2. Build and install a release

From the repository root (`pnpm` 11, per `packageManager`):

```bash
pnpm -C services/status-server/probe install --frozen-lockfile
pnpm -C services/status-server/probe typecheck
pnpm -C services/status-server/probe test
pnpm -C services/status-server/probe build      # → dist/cognia-status-probe.mjs
sha256sum services/status-server/probe/dist/cognia-status-probe.mjs
```

On the host, use versioned release directories plus a `current` symlink, so an upgrade or rollback is one atomic rename:

```bash
VERSION=0.1.0-$(git rev-parse --short HEAD)       # record the exact source SHA
sudo install -d -m 0755 /opt/cognia-status-probe/releases/$VERSION
sudo install -m 0444 cognia-status-probe.mjs /opt/cognia-status-probe/releases/$VERSION/
sudo install -m 0444 README.md /opt/cognia-status-probe/README.md
sudo ln -sfn /opt/cognia-status-probe/releases/$VERSION /opt/cognia-status-probe/current.next
sudo mv -T /opt/cognia-status-probe/current.next /opt/cognia-status-probe/current
node /opt/cognia-status-probe/current/cognia-status-probe.mjs --version
```

## 3. Probe secret and key ID

Generate 32 random bytes, encoded as base64url. The probe and the status Worker must hold the same value. Never paste it into a ticket, log or commit.

```bash
sudo install -d -m 0700 /etc/cognia-status-probe
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' \
  | sudo tee /etc/cognia-status-probe/probe.secret >/dev/null
sudo chmod 0600 /etc/cognia-status-probe/probe.secret
```

The probe warns (`secret_file_permissive`) if the file is group- or world-readable. Under systemd, the unit reads it through `LoadCredential=`, so only the service sees `/run/credentials/cognia-status-probe.service/probe-secret`.

Choose a key ID such as `ext-1-k1` (`<probeId>-k<n>`). The key ID is public; only the secret is sensitive.

### Status Worker secret

`PROBE_SECRETS` is a JSON object mapping key IDs to base64url secrets, and it holds **every** active probe key. Merge the new key with the existing ones, staging first:

```bash
cd services/status-server/worker
# Compose the JSON locally from your secret store; never echo it into shell history.
wrangler secret put PROBE_SECRETS --env staging   # paste {"cf-...":"...","ext-1-k1":"<secret>"}
wrangler secret put PROBE_SECRETS                 # production, after staging passes
```

**Key rotation:** add `ext-1-k2` to `PROBE_SECRETS` and to the probe's registry key list, switch `keyId` and `probe.secret` on the host, restart, confirm `ingest_ok`, then remove `k1` from both.

## 4. Enroll the probe in the registry

Enrollment is an operator action through the admin CLI, `services/status-server/admin`, owned by work-package E. The admin CLI defines the exact flags. Its request is `ProbeEnrollRequest` in `lib/status/contract.ts`, so the command has this shape:

```bash
cognia-status-admin probe enroll \
  --probe-id ext-1 \
  --source external \
  --label-en "External reference probe" --label-zh-CN "外部参考探针" \
  --location-en "Frankfurt, Germany" --location-zh-CN "德国法兰克福" \
  --provider "Hetzner Cloud" \
  --enrolled-at 2026-10-03T08:00:00Z \
  --profile native:60:60 --profile web:-:300 --profile ios:-:300 --profile android:-:300 \
  --key-id ext-1-k1
# profile syntax: <id>:<httpCadenceSeconds|->:<protocolCadenceSeconds|->
```

- `--enrolled-at` is a future UTC minute. The server refuses observations before it, so start the service at or after that minute. Earlier batches would be rejected with 403, dropped, and raise an `ingestion_rejected` alert.
- The command prints the new **registry revision**. Put it in the probe config as `registryRevision`. A batch that claims a revision newer than the server's is refused.
- The profiles and cadences here must match the probe config. A profile that is not registered is refused (`profile_not_registered`).

## 5. Configure and start the probe (systemd)

```bash
sudo install -m 0644 probe.config.example.json /etc/cognia-status-probe/config.json
sudoedit /etc/cognia-status-probe/config.json
#   probeId / keyId / registryRevision   from the enrollment
#   secretFile  /run/credentials/cognia-status-probe.service/probe-secret   (systemd)
#   spoolDir    /var/lib/cognia-status-probe/spool
#   alertWebhook  the fixed operator webhook (HTTPS), or null to log only
#   profiles      the exact Origins the signaling allowlist admits:
#                 web https://cognia.cn, ios capacitor://localhost, android https://localhost
sudo install -m 0644 systemd/cognia-status-probe.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/cognia-status-probe.service
sudo systemctl daemon-reload
sudo systemctl enable --now cognia-status-probe
journalctl -u cognia-status-probe -f -o cat
```

Expected log lines (JSON, one per line, non-secret IDs only):

```text
{"level":"info","event":"probe_start","probeId":"ext-1","profiles":"native,web,ios,android","recoveredBatches":0,...}
{"level":"info","event":"run_complete","profileId":"native","runId":"r…","checks":"signalingHttp=pass,signalingAuth=pass,relayData=pass,statusPage=pass,statusApi=pass",...}
{"level":"info","event":"ingest_ok","runId":"r…","status":202,"outcome":"accepted",...}
```

`systemd-analyze security cognia-status-probe` should report a low exposure score. The unit uses `DynamicUser`, `ProtectSystem=strict` with only the state directory writable, `NoNewPrivileges`, no capabilities, and a syscall filter.

### Shadow period, then set the reference

Let the probe ingest for at least 24 h and confirm the public snapshot lists it with fresh `lastAttemptAt`/`lastSuccessAt`. Then make it the reference observer **at a future minute boundary**:

```bash
cognia-status-admin probe set-reference --probe-id ext-1 \
  --effective-at 2026-10-04T00:00:00Z --reason "external reference after 24h shadow"
```

Earlier history is never rewritten. The previous reference keeps its series up to the boundary.

## 6. Mirror

### Assets

The integration owner (F) builds the status-only export (the `/status` HTML plus the `_next/static/**` chunks, CSS and fonts it references). The mirror detects either export layout, `status/index.html` or `status.html`. Releases are versioned and switched atomically, so old HTML never references deleted chunks:

```bash
SHA=<build sha>
sudo install -d -m 0755 /srv/cognia-status-mirror/releases/$SHA
sudo cp -R status-export/. /srv/cognia-status-mirror/releases/$SHA/     # world-readable files
sudo ln -sfn /srv/cognia-status-mirror/releases/$SHA /srv/cognia-status-mirror/current.next
sudo mv -T /srv/cognia-status-mirror/current.next /srv/cognia-status-mirror/current
```

The server re-resolves `current` per request, so no restart is needed. Keep at least the two previous releases for rollback and for clients holding older HTML. Never delete the release `current` points at.

### Service and TLS

```bash
sudo install -d -m 0755 /etc/cognia-status-mirror
sudo install -m 0644 mirror.config.example.json /etc/cognia-status-mirror/config.json
sudo install -m 0644 systemd/cognia-status-mirror.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cognia-status-mirror
sudo cp Caddyfile.example /etc/caddy/Caddyfile   # set the real mirror hostname and email
sudo systemctl reload caddy
curl -sI https://status-mirror.example.org/            # 302 → /status/
curl -s  https://status-mirror.example.org/api/status/v1/healthz
```

Alternatively, set `mirror.enabled: true` in the probe config to run the mirror inside the `run` process. Separate units keep the processes independent, so a probe crash does not take the mirror down.

Then ask the status Worker owner (B/F) to publish the mirror URL in `capabilities.mirrorUrl`.

### What the mirror proves, and what it does not

- **It proves** that the last validated public snapshot, with its original timestamps, stays readable from a non-Cloudflare host while the primary or Cloudflare is unreachable. The page recomputes staleness from those timestamps, never upgrades old green evidence to current, and disables subscriptions and other writes in mirror mode.
- **It does not prove** current service health during a primary outage. Snapshots stop advancing and the page shows them as stale. It is also not disaster recovery: if this host fails, one witness and the mirror are lost together. `GET /api/status/v1/healthz` (`lastSyncAt`, `lastSyncOk`) exposes that. It has no incident API (503), no subscription, admin or ingest routes, and it accepts no writes (405).

## 7. Docker alternative

```bash
docker build -f deploy/Dockerfile -t cognia-status-probe:$VERSION services/status-server/probe
docker run -d --name cognia-status-probe --restart=always \
  -v /etc/cognia-status-probe:/config:ro \
  -v cognia-status-spool:/var/lib/cognia-status-probe \
  cognia-status-probe:$VERSION run --config /config/config.json
```

In the container config, set `secretFile` to `/config/probe.secret`. Make that file readable by uid 1000 (`node`) and nobody else. For the mirror, set `host` to `0.0.0.0`, publish `-p 127.0.0.1:8080:8080`, and mount the assets read-only.

## 8. Operations

| Signal                                                     | Meaning                                                                                                 | Action                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| alert `ingestion_failing`                                  | POSTs have been failing for more than 3 min                                                             | Check status API health, the host clock (signature window), the key in `PROBE_SECRETS`, and outbound network   |
| alert `ingestion_rejected`                                 | The server refused a batch (4xx other than 408/409/429)                                                 | 401: key or clock. 403: enrollment time, disabled probe, or unregistered profile/check. 400: registry revision |
| alert `status_api_failing`                                 | The primary status API failed 3 consecutive minutes                                                     | Status Worker/D1 incident; signaling may be fine                                                               |
| alert `spool_overflow`                                     | More than 1 MiB of unsent batches; the oldest were dropped                                              | Long ingestion outage. The dropped minutes are history gaps                                                    |
| log `observer_gap` (`overlap_skipped`/`aborted`/`missing`) | A minute was not observed: the previous run overran, shutdown interrupted it, or the host was suspended | Shown as missing coverage. It is never a service failure                                                       |
| log `observer_loss`                                        | A batch aged out of the 10-min window or overflowed                                                     | Same as above                                                                                                  |
| log `ingest_conflict`                                      | 409: the same run ID was already stored with a different body                                           | Should not happen, because retries resend identical bytes. Check for two hosts sharing one probe ID            |

Alerts are de-duplicated per key for 30 min. Logs never contain room IDs, keys, signatures, request bodies or IPs.

**Spool semantics:** each batch is written atomically to `spoolDir` before its first POST and removed after a definitive answer. A restart resumes the remaining batches with the same run ID and identical bytes, so the server records a duplicate, not a second slot. A batch older than 10 min from its scheduled minute is dropped and counted as loss, never sent as current health.

**Shutdown:** SIGTERM aborts in-flight runs (not submitted, logged as `observer_gap`), stops retries and keeps unsent batches on disk.

## 9. Rollback

- **Probe binary:** point `current` back at the previous release (`ln -sfn …/releases/<prev> current.next && mv -T current.next current`), then run `systemctl restart cognia-status-probe`.
- **Misbehaving probe:** `cognia-status-admin probe disable --probe-id ext-1 --reason "…"`. History is retained, and the page shows coverage/unknown until a replacement is enrolled. If it is the reference, set another reference at a future minute; earlier history stays as it is.
- **Mirror assets:** swap `current` back to the previous release directory. No restart is needed.
- **Key compromise:** remove the key from `PROBE_SECRETS` right away (ingestion stops with 401), then rotate as in §3.

## 10. Verification commands

```bash
pnpm -C services/status-server/probe typecheck
pnpm -C services/status-server/probe test        # unit + loopback integration, no public network
pnpm -C services/status-server/probe test:live   # opt-in: real wss://signaling.cognia.cn runs for native/web/ios/android; nothing is ingested
pnpm -C services/status-server/probe build
node --test services/signaling-server/worker/tests/synthetic-room.test.mjs
```

`test:live` creates fresh throwaway rooms with new P-256 keys and touches no accounts. Run it from the probe host before enrollment to confirm that DNS, TLS, the WSS upgrade with each Origin, and the data lane work from that network.
