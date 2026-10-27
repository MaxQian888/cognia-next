# @cognia/agent-rovo

Rovo Dev native session HTTP/SSE integration behind Cognia's ADR-0217 fetch, service-launch, approval and privacy ports. A dedicated package is needed because the first-party Atlascode protocol uses named SSE events, partial tool arguments and permission batches, rather than ACP.

`RovoDevAdapter` takes `fetch`, `outboundGate`, `redactDiagnostic`, `approvalPolicy`, optional `isToolPreApproved` and optional `launch(config,cwd,signal)`. A launched service returns `{endpoint,headers,close}`. The adapter creates/restores native sessions, validates the workspace, sends the message, parses bounded named SSE, collects all tool decisions before native resume, and completes only on `close`. Truncation, malformed/unknown events, upstream exceptions and unsupported deferred questions fail the turn. Cancellation calls the native API and aborts streaming.

The app launcher starts fixed `acli rovodev serve PORT --respect-configured-permissions` with a random `ROVODEV_SERVE_SESSION_TOKEN`. Health is only readiness: `/v3/sessions/list` must reject missing/wrong bearer tokens and accept the owned token before attachment. A token-ignoring listener cannot be adopted. Process ownership is local; selected runtime environments and explicit external endpoints are rejected by the app launcher.

Host MCP injection, extra workspace roots, path-only file context, model/reasoning controls and forks are unsupported. Inline text file content is accepted. The CLI owns login/site configuration. There is no invented release pin for its closed server implementation.

Contract sources: [first-party API client](https://github.com/atlassian/atlascode/blob/main/src/rovo-dev/client/rovoDevApiClient.ts), [native event parser](https://github.com/atlassian/atlascode/blob/main/src/rovo-dev/client/responseParser.ts), [owned process launch](https://github.com/atlassian/atlascode/blob/main/src/rovo-dev/rovoDevProcessManager.ts).
