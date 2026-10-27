# @cognia/agent-openclaude

OpenClaude's native bidirectional `stream-json` CLI integration, behind the host
ports in ADR-0217. The independent OpenClaude CLI remains installed and signed in
by the user. Its protocol is distinct from ACP and OpenCode HTTP.

The package owns framing, per-session process lifecycle, explicit native resume,
turn interruption, streaming messages/tools/usage and fail-closed tool approvals.
The host owns process confinement, credentials, outbound privacy policy, approval
rules and redacted diagnostics. The pure `./manifest` entry starts no runtime.

Only inline base64 images and text are accepted. Unsupported content and
ACP-channel MCP configurations fail explicitly. Interrupted turns must produce
a terminal response; otherwise the process is killed and the error is surfaced.
Native authentication and paid-provider acceptance are separate from unit tests.
