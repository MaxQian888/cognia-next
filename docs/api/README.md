# API specifications

OpenAPI 3.1 contracts for the HTTP and WebSocket surfaces exposed by the Cognia
native runtime. These endpoints do not exist in web-only builds because the
Next.js application is a static export.

| File                                                                       | Surface                                                         | Default listener           | Authentication                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| [`mobile-companion-api.openapi.yaml`](./mobile-companion-api.openapi.yaml) | Paired-device API, RPC, event and terminal sockets              | `https://127.0.0.1:27890`  | Five-minute DPoP-bound device access token and single-use socket tickets                  |
| [`headless-service-api.openapi.yaml`](./headless-service-api.openapi.yaml) | Renderer-free Brain RPC, events, bridge, and IDE content broker | `https://127.0.0.1:27890`  | Process-scoped opaque token from `--local-debug`, or a 24-hour service JWT; loopback only |
| [`mcp-http.openapi.yaml`](./mcp-http.openapi.yaml)                         | External Bridge MCP                                             | Random loopback port       | Static bearer token                                                                       |
| [`workflow-webhook.openapi.yaml`](./workflow-webhook.openapi.yaml)         | Workflow webhook receiver                                       | Configurable loopback port | Optional per-trigger HMAC-SHA-256                                                         |
| [`connectors-webhook.openapi.yaml`](./connectors-webhook.openapi.yaml)     | Connector ingress and OneBot WebSocket                          | Configurable               | Adapter-specific                                                                          |

`connectors-webhook.openapi.yaml` describes the **standalone** connectors
listener. On a headless host the same router is also nested under
`/connectors` on the companion listener, and on a `/integrations/lark` mount
alongside it. Those seventeen mounted routes are declared in
`protocol/companion-api-routes.json` with a stated reason and are, for now,
absent from both generated specs: they are inbound third-party surfaces
(webhooks, OAuth callbacks, browser login) and loopback fleet ingress, not
paired-device commands. Authoring them into the headless document is tracked as
follow-up and needs each handler's real status codes rather than a generic
shape.

For a verified local import, TLS certificate, token, HTTP request, and
WebSocket setup, see the bilingual Fumadocs page
`subsystems/companion-api/apifox-debugging`.

## Companion contract sources

Do not hand-edit generated RPC path inventories. The generator combines:

- `protocol/companion-api-routes.json` for mounted-route classification;
- `protocol/companion-commands.json` for target, transport, risk, approval, and schema metadata;
- `protocol/companion-request-schemas.json` for explicit detailed request contracts;
- Zod 4 contracts in `scripts/build/companion-request-schema-contracts.mjs` for delegated and
  recursively nested request shapes;
- `protocol/companion-command-renames.json` for the old-name to new-name table (ADR-0175);
- the Rust dispatch arms, scanned for the `arm` each remote descriptor names. The runtime
  allowlist is no longer typed by hand: the generator renders the contract into
  `src-tauri/src/companion_api/generated/known_commands.rs` and `command_manifest.rs` reads it;
- Rust dispatch arms for command-specific required/optional request fields and primitive types;
- the existing public specification for non-RPC route and reusable component schemas.

Concrete RPC operations include `x-cognia-request-schema-source`. A value of `contract`,
`zod-contract`, `runtime-inferred`, or `manifest` gives API clients a concrete request schema.
Generation fails if any Headless RPC would use a generic fallback, if an array lacks an `items`
schema, or if an unconstrained object could produce placeholder request fields.

The paired-device and Headless contracts are deliberately separate. Public
commands must target `execution` or `host-admin` and support the HTTP
transport. The Headless specification contains every remote-executable command
(every descriptor whose target is not `client`), including service-only
commands. A running Host lists the same thing at `GET /api/catalog` (filtered by
the device's grants) and `GET /internal/catalog`, and `GET /api/whoami` names the
`contractVersion` and `catalogHash` it serves.

## Tooling

```bash
pnpm companion-api:gen    # regenerate both Companion specs
pnpm companion-api:check  # fail when committed specs drift from source
pnpm companion-api:lint   # validate both specs with the pinned Redocly CLI
```

`companion-api:check` is part of the repository artifact gate. Rust parity
tests independently compare both generated concrete RPC inventories with the
runtime allowlist.

## Versioning and compatibility

Canonical device routes are unversioned: `/api/*` and `/ws/*`. DPoP access
tokens expire after five minutes; WebSocket tickets expire after 60 seconds and
are single-use. Versioned public paths and legacy device-JWT compatibility
aliases are intentionally absent and return 404.

The Headless surface is internal and versioned with the application. Its
`/internal/*` routes are never a substitute for the paired-device API and are
rejected for non-loopback peers.

The command contract itself carries one version, `contractVersion` in
`protocol/companion-commands.json` (ADR-0175). Command names follow one
grammar, `<resource>.<verb>`, over `protocol/companion-resources.json` and
`protocol/companion-verbs.json`; `protocol/companion-command-renames.json`
records the old snake_case name of every command until the rename cut lands,
and `pnpm audit:command-grammar` holds the three files to each other.

## Out of scope

- Tauri `invoke()` commands and in-process `cognia://` events;
- upstream model-provider APIs used by sidecars;
- OAuth endpoints where Cognia is the client rather than the server.
