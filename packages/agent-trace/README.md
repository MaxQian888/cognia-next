# @cognia/agent-trace

OpenTelemetry-compatible agent-tracing toolkit for Cognia: a span lifecycle
emitter (start / record / end with a pluggable writer registry), OTLP
serialization, a structured-log bridge (span ⇄ log entry), token cost
estimation, and chat tool-call span helpers.

Framework-agnostic and dependency-free at the npm level — span/log types and the
plugin message bus are reached back through the `@/` alias.

```ts
import { startSpan, endSpan } from "@cognia/agent-trace/emitter"
import { spanToOtlp } from "@cognia/agent-trace/span-to-otlp"
```

Consumed in dev/test from source (`packages/agent-trace/src`).
