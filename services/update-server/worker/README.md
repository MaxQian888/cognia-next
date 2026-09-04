# cognia-update-worker

Cloudflare Worker control plane for Cognia updates.

## What it does and does not do

It serves two client endpoints and an admin surface. It stores **no binaries**:
packages live in GitHub Releases, the App Store, Google Play, the extension
stores and npm.

It also **signs nothing**. CI signs the catalog bundle offline and uploads it.
The client verifies that bundle against a root compiled into the app, so a
compromise of this Worker cannot make a device install anything: a forged
bundle is refused by the client, and the Tauri endpoint's packages are still
minisign-verified by the desktop updater.

## Endpoints

| Route                                                          | Purpose                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /v1/catalog?channel=`                                     | The signed metadata bundle for a channel, or `204` when none is published. |
| `GET /v1/tauri/:target/:arch/:currentVersion?channel=&bucket=` | Tauri updater manifest, or `204` when the caller is current.               |
| `POST /v1/admin/releases`                                      | Stage a release (invisible to clients).                                    |
| `POST /v1/admin/releases/:id/promote`                          | Step the rollout: 1, 10, 25, 50, 100.                                      |
| `POST /v1/admin/releases/:id/pause`                            | Hold the rollout at its current share.                                     |
| `POST /v1/admin/releases/:id/abort`                            | Kill switch. Takes effect on the next check.                               |
| `POST /v1/admin/releases/:id/revoke`                           | Permanent withdrawal.                                                      |
| `POST /v1/admin/catalog`                                       | Publish a signed bundle for one channel.                                   |

Admin routes need `Authorization: Bearer $UPDATE_ADMIN_SECRET`.

## Operator setup

```bash
wrangler d1 create cognia-updates
wrangler d1 migrations apply cognia-updates --remote
wrangler secret put UPDATE_ADMIN_SECRET
```

Then paste the database id into `wrangler.toml` and deploy.

The client's trust root is separate and never touches this repo: generate the
ed25519 role keys offline, and inject the root payload into the app build as
`NEXT_PUBLIC_UPDATE_TRUST_ROOT` (base64 JSON).

## Tests

```bash
pnpm test
```

Runs in workerd via miniflare with a local D1. No Cloudflare account needed.
