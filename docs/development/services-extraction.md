# cognia-services repository ownership

The cloud and self-hosted services are maintained in [cognia-labs/cognia-services](https://github.com/cognia-labs/cognia-services): signaling, share, status, identity, sync, update, diagnostics and the Logto mail Worker. Install, develop, test, build images and deploy them from that checkout. The history of every moved path was preserved. `services/workspace-runtime/` stays in this repository because it is staged into the desktop bundle and built with the app.

## Contracts the services repository owns

The services repository owns the wire contracts that both sides consume, and this repository installs them at one pinned revision:

| Contract                   | Services path                    | Consumed here as                                               |
| -------------------------- | -------------------------------- | -------------------------------------------------------------- |
| Signaling envelope crate   | `services/signaling-server/core` | Cargo `cognia-signaling-core` (`[workspace.dependencies]` git) |
| Account sync rules/vectors | `packages/sync-protocol`         | pnpm `@cognia/sync-protocol` (root and `cli/`)                 |
| Public status v1 contract  | `packages/status-contract`       | pnpm `@cognia/status-contract`, re-exported by `lib/status/`   |

Both TypeScript packages ship source. `tsconfig` paths, the Jest mapper and `transpilePackages` resolve them from `node_modules`. `lib/status/*.ts` and `lib/signaling/relay-health.ts` stay as one-line re-exports so existing imports keep working; the contract tests live with the contract.

Smaller contracts are kept as byte-identical copies beside the code that reads them: the grant wire vector (`crates/cognia-tenant-auth/fixtures/`), the diagnostic OpenAPI document and the share constants (`protocol/cognia-services/`). The JCS vectors are compared by content.

## The pin

`integrations/cognia-services.json` names the revision. The Cargo dependency, both `package.json` entries and both lockfiles must name the same one; `pnpm cognia-services:check` fails otherwise. The `cognia-services` lane in `test.yml` checks the pinned revision out under `.cache/cognia-services` and:

1. runs `scripts/ci/check-cognia-services.mjs --services-root .cache/cognia-services`, which also compares every copy above against that checkout;
2. runs the signaling room-id vector of the pinned crate;
3. runs the suites that read service sources with `COGNIA_SERVICES_ROOT` set: tenant RLS against the diagnostic server migrations, diagnostic audit actions, and the status-site headers against the status Worker. Without the variable those suites skip, so a plain local run stays green.

The compose and server benchmark lanes build the signaling and share images from the same checkout. Compose defaults pull `ghcr.io/cognia-labs/cognia-{signaling,share}`, which the services repository publishes; `scripts/gates/check-deploy-suite.mjs` holds that owner.

For local runs, fetch the pinned revision and point the suites at it:

```sh
pnpm cognia-services:fetch
COGNIA_SERVICES_ROOT=$PWD/.cache/cognia-services pnpm test -- lib/diagnostic-service/types.test.ts
node scripts/ci/check-cognia-services.mjs --services-root .cache/cognia-services
```

## Changing a contract

Land the change in cognia-services first, with its own tests. Then bump the pin here in one change: update `integrations/cognia-services.json`, the `rev` in `Cargo.toml`, the three package URLs, run `cargo update -p cognia-signaling-core` and `pnpm install`, refresh any copied file, and run the check with `--services-root`. A pin left behind in a lockfile installs the old contract silently, which is why the check reads both lockfiles.

The status Worker builds the public status page from a pinned revision of this repository (`integrations/cognia-next.json` in cognia-services). Bump that pin there when the page changes.

## Documentation

Service documentation lives with the services. cognia-services keeps a README per service and package, [contracts](https://github.com/cognia-labs/cognia-services/blob/main/docs/contracts.md) and [releasing](https://github.com/cognia-labs/cognia-services/blob/main/docs/releasing.md) guides, and its own `CONTRIBUTING.md`, `SECURITY.md` and `AGENTS.md`. These moved there from this repository and are maintained there:

- the account sync protocol specification (`docs/protocols/account-sync-protocol{,.zh}.md`); the docs site keeps a short page that links to it;
- the sync and identity Worker runbooks (`docs/runbooks/`);
- the public status implementation plan (`docs/plans/2026-10-02-signaling-public-status-implementation.md`).

The decision records stay here. cognia-services keeps English and Chinese copies of the ones its services follow (ADR-0021, 0037, 0102, 0135, 0149, 0170, 0211, 0215, 0224) under `docs/adr/`; amend a record here first, then refresh its copy there.

## Deployments and secrets

Service deployments (Workers, Fly.io) and image publishing run in cognia-services, gated by its own `DEPLOY_ENABLED` variable and the `staging` / `production` environments described in its README. `deploy.yml` here deploys only the docs and marketing sites.
