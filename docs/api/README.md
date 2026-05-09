# API specifications

OpenAPI 3.1 specs for every HTTP / WebSocket surface exposed by cognia-next.

Each surface runs in the Tauri Rust process on its own listener. None of these
endpoints exist in web mode (no Next.js API routes — `output: "export"`).

| File                                                                       | Surface                                               | Source                                              | Default port                                | Bind                   | Auth                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| [`mobile-companion-api.openapi.yaml`](./mobile-companion-api.openapi.yaml) | Mobile pair, RPC, event stream                        | `src-tauri/src/companion_api/`                      | 7890                                        | 127.0.0.1 (LAN toggle) | Pair JWT (5 min, single-use) → Device JWT (90 d, HS256) |
| [`mcp-http.openapi.yaml`](./mcp-http.openapi.yaml)                         | External Bridge MCP for coding agents                 | `src-tauri/src/mcp_server/http_server.rs`           | random                                      | 127.0.0.1 only         | Static bearer (constant-time)                           |
| [`workflow-webhook.openapi.yaml`](./workflow-webhook.openapi.yaml)         | `trigger.webhook` receiver                            | `src-tauri/src/workflow/triggers/webhook_router.rs` | random or `AppSettings.workflowWebhookPort` | 127.0.0.1              | Optional per-trigger HMAC-SHA-256                       |
| [`connectors-webhook.openapi.yaml`](./connectors-webhook.openapi.yaml)     | Telegram / Slack / Discord / Lark inbound + OneBot WS | `src-tauri/src/connectors/`                         | configurable                                | configurable           | Per-adapter signature scheme; OneBot bearer             |
| [`remote-control.openapi.yaml`](./remote-control.openapi.yaml)             | Local task-trigger / event-bridge                     | `src-tauri/src/remote_control/server.rs`            | 47821                                       | 127.0.0.1 only         | Bearer + IPv4 allowlist + rate limit                    |

## Versioning

The `info.version` field of each spec is the `Cargo.toml` package version of
`src-tauri/` at the time the spec was last regenerated. The five surfaces ship
out of one binary, so they share that version. Update them together when the
crate's `version` is bumped.

## Editing

Field shapes mirror Rust structs in `src-tauri/src/...` with `#[serde(rename_all = "camelCase")]`.
When a struct is changed, update the corresponding `components.schemas` entry
**and** any inline examples that depend on it.

## Tooling

Lint with either tool — install one if you don't have it:

```powershell
# Redocly (richer report; requires npx)
npx --yes @redocly/cli@latest lint docs/api/mobile-companion-api.openapi.yaml

# swagger-cli (lighter; OpenAPI 3.0 schema strict)
npx --yes @apidevtools/swagger-cli@latest validate docs/api/mobile-companion-api.openapi.yaml
```

Render locally:

```powershell
# Redocly
npx --yes @redocly/cli@latest preview-docs docs/api/mobile-companion-api.openapi.yaml
# Swagger UI (Docker)
docker run -p 8088:8080 -v "${PWD}/docs/api:/specs" -e SWAGGER_JSON=/specs/mobile-companion-api.openapi.yaml swaggerapi/swagger-ui
```

## What is NOT here

- The `cognia://...` Tauri events used between the Rust backend and the
  embedded webview (e.g., `companion://device-paired`, `workflow:trigger`,
  `remote-control://run-task`). Those are an in-process IPC channel, not HTTP.
- The `invoke()` Tauri command surface (`companion_server_start`,
  `mcp_server_start`, `workflow_register_trigger`, …). Those are also in-process
  and have no HTTP representation.
- The Claude OAuth flow against `claude.ai` / `console.anthropic.com` —
  cognia-next is the **client** there, not the server.
- The Anthropic / OpenAI / Google APIs the sidecar talks to — same reason.
