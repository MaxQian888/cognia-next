# cognia-update-worker

Cloudflare Worker control plane for Cognia updates.

## What it does and does not do

It serves three client endpoints and an admin surface. It stores **no binaries**:
packages live in GitHub Releases, the App Store, Google Play, the extension
stores and npm.

It also **signs nothing**. CI signs the catalog bundle offline and uploads it.
The client verifies that bundle against a root compiled into the app, so a
compromise of this Worker cannot make a device install anything: a forged
bundle is refused by the client, and the Tauri endpoint's packages are still
minisign-verified by the desktop updater.

## Endpoints

| Route                                                                                    | Purpose                                                                            |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/catalog?channel=`                                                               | The signed metadata bundle for a channel, or `204` when none is published.         |
| `GET /v1/tauri/:target/:arch/:currentVersion?channel=&bucket=`                           | Tauri updater manifest, or `204` when the caller is current.                       |
| `GET /v1/rollout/:kind/:assetId/:target/:arch/:currentVersion?channel=&bucket=&manual=1` | Live rollout answer (version, digest) for an asset that installs itself, or `204`. |
| `POST /v1/admin/releases`                                                                | Stage a release (invisible to clients).                                            |
| `POST /v1/admin/releases/:id/promote`                                                    | Step the rollout: 1, 10, 25, 50, 100.                                              |
| `POST /v1/admin/releases/:id/pause`                                                      | Hold the rollout at its current share.                                             |
| `POST /v1/admin/releases/:id/abort`                                                      | Kill switch. Takes effect on the next check.                                       |
| `POST /v1/admin/releases/:id/revoke`                                                     | Permanent withdrawal.                                                              |
| `POST /v1/admin/catalog`                                                                 | Publish a signed bundle for one channel.                                           |

Admin routes need `Authorization: Bearer $UPDATE_ADMIN_SECRET`.

## Always-on host releases (ADR-0224 A10)

A host release ships its server and brain as one unit, so the signed catalog
lists it as a `host-server` entry (the archive's `url` and `sha256`, or the
Compose image's repository and `sha256:` digest) paired with a `host-brain`
entry of the same version; both name the command contract. Targets are
`darwin-arm64`, `darwin-x64`, `oci-slim-amd64` and `oci-full-amd64` (a Compose
host stays on the image variant it runs). The Worker splits a target at its
last hyphen into its `target` and `arch` columns.

A host installs a release only when it is in the verified catalog **and**
`/v1/rollout/host-server/host/<target>/<arch>/<current>` (for example
`/v1/rollout/host-server/host/oci-full/amd64/1.3.0`) names it for the
host's bucket. The second check is the kill switch: `pause` or `abort` holds
the release back on the next check, and since a host matches the answer's
version and digest against its catalog, this Worker can withhold a release but
never substitute one. `manual=1` (someone asked the host to update) skips the
percentage, never a pause or abort.

The release is signed and published offline with
`scripts/release/update-catalog.mjs` (`pnpm update:catalog`):

```bash
pnpm update:catalog keygen --keys ~/cognia-update-keys      # once, offline
pnpm update:catalog root --keys ~/cognia-update-keys --version 1 \
  --expires 2031-01-01T00:00:00Z --out root.json            # prints the trust-root env value
pnpm update:catalog host-entries --version 1.4.0 --channel stable --target darwin-arm64 \
  --archive dist/host/cognia-host-1.4.0-darwin-arm64.tar.gz \
  --url https://github.com/<owner>/cognia/releases/download/v1.4.0/cognia-host-1.4.0-darwin-arm64.tar.gz \
  --out entries.json
pnpm update:catalog host-entries --version 1.4.0 --channel stable --target oci-full-amd64 \
  --image ghcr.io/<owner>/cognia-server --digest sha256:<from the images workflow> --out entries.json
pnpm update:catalog sign --keys ~/cognia-update-keys --root root.json \
  --entries entries.json --previous last-stable.json --out stable.json
UPDATE_ADMIN_SECRET=… pnpm update:catalog publish --bundle stable.json --channel stable --url https://update.cognia.cn
UPDATE_ADMIN_SECRET=… pnpm update:catalog stage-host --entries entries.json --url https://update.cognia.cn
```

`sign` refuses a host release missing either half, naming two contracts, or
without a pinned package; `--previous` keeps every role version increasing,
which clients require. Then step the staged rows through `promote` as for the
desktop.

## Operator setup

```bash
wrangler d1 create cognia-updates
wrangler d1 migrations apply cognia-updates --remote
wrangler secret put UPDATE_ADMIN_SECRET
```

Then paste the database id into `wrangler.toml` and deploy.

The client's trust root is separate and never touches this repo: generate the
ed25519 role keys offline, and inject the root payload into the app build as
`NEXT_PUBLIC_UPDATE_TRUST_ROOT` (base64 JSON), and into an always-on host as
`COGNIA_UPDATE_TRUST_ROOT`. `pnpm update:catalog root` prints the value.

## Tests

```bash
pnpm test
```

Runs in workerd via miniflare with a local D1. No Cloudflare account needed.
