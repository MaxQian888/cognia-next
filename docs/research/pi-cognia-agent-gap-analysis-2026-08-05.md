# Pi ↔ Cognia Agent SDK Gap Analysis (2026-08-05)

## Purpose

This document audits the `@anthropic-ai/claude-code` (Pi) v0.83.0 public SDK
against the Cognia equivalent (`@cognia/agent` + `cognia-agent rpc`) to
determine which Pi features are genuine gaps requiring implementation, which
are already covered by existing Cognia infrastructure under different names,
and which have been intentionally rejected as duplicates of existing subsystems.

---

## 1. Shipped Pi v0.83.0 Features

| Feature              | Pi API                               | Status in Cognia                                                 |
| -------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| One-shot `query()`   | `sdk.query(prompt, opts)`            | ✅ `session.run()` via `runUnifiedTurn`                          |
| Streaming events     | `for await (const event of stream)`  | ✅ `onEnvelope` callback with canonical `AgentEventEnvelope`     |
| Multi-turn sessions  | `session.send(prompt)`               | ✅ `CogniaSession.run()` with `ProviderSessionLease` persistence |
| Session resume       | `sdk.resumeSession(id)`              | ✅ Canonical session store with resume fidelity report           |
| Tool definitions     | `tools: [{ name, schema, execute }]` | ✅ `createTool()` in `lib/ai/tools/tool-utils.ts`                |
| Tool strict mode     | `tool.strict: true`                  | ✅ Now exposed as public policy (`off`/`prefer`/`require`)       |
| Permission callbacks | `onPermission(req) => response`      | ✅ `PermissionResponder` gate (default: timeout-deny in SDK)     |
| System prompt        | `systemPrompt: string`               | ✅ Via `config.systemPrompt` in `ResolvedConfig`                 |
| Max turns            | `maxTurns: number`                   | ✅ `maxSteps` parameter                                          |
| Model selection      | `model: string`                      | ✅ `config.model`                                                |
| Custom instructions  | `claudeInstructions: string`         | ✅ Via character/session overrides in `resolveSendOptions`       |
| Abort                | `controller.abort()`                 | ✅ `session.abort()` via `AbortController`                       |
| Usage reporting      | event with token counts              | ✅ `AgentRunUsage` in result + `usage` canonical event           |
| JSON result          | structured final result              | ✅ `AgentRunResultV1` schema                                     |
| Error codes          | typed error responses                | ✅ `AgentStructuredError` with 16 stable codes                   |
| Exit codes           | process exit semantics               | ✅ `AGENT_EXIT_CODES` mapping                                    |

## 2. Unreleased Pi Upstream Features (as of 2026-08-05)

| Feature                     | Status                    | Cognia Decision                                                                                                                                                        |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation compaction API | Pi internal, not shipped  | ✅ Existing 6-strategy compaction engine (summary, sliding-window, selective, hybrid, recursive, optical) + plugin strategy registry + now dynamic via PreCompact hook |
| Session annotations         | Design doc only           | ✅ Implemented: `session.appendAnnotation()` → canonical `content-part/custom` envelope                                                                                |
| Provider wire hooks         | Design doc, controversial | ❌ Rejected (see §5)                                                                                                                                                   |
| Embedded MCP                | Experiment branch         | ✅ Existing MCP integration (dynamic servers, permissions, tool bridge)                                                                                                |

## 3. Cognia Equivalents (features Pi does NOT have)

| Cognia Feature                                       | No Pi Equivalent       |
| ---------------------------------------------------- | ---------------------- |
| Three runtime rails (Claude SDK, AI SDK, External)   | Pi is Anthropic-only   |
| Frozen execution spec with capability matrix         | No preflight in Pi     |
| Canonical session format with 5-level fidelity scale | Pi has opaque sessions |
| Session fork / clone / tree                          | No branching in Pi     |
| Optical compaction (rasterize + verify readability)  | No equivalent          |
| Plugin compaction strategy registry                  | No extension point     |
| Agent team with multi-backend dispatch               | Single agent only      |
| Provider routing engine with gateway                 | Direct only            |
| External agent hosting (`cognia-agent x`)            | No external agents     |
| Credential reference pattern (never inline secrets)  | Accepts raw keys       |
| Attachment lowering with type validation             | String-only input      |
| Resume fidelity with loss reports                    | Opaque resume          |
| JSON-RPC public protocol                             | No RPC in Pi           |

## 4. Genuine Gaps Addressed in This Implementation

| Gap                              | Resolution                                            |
| -------------------------------- | ----------------------------------------------------- |
| No public SDK package            | `@cognia/agent` facade over `runUnifiedTurn`          |
| No public RPC protocol           | `cognia-agent rpc` + `@cognia/agent/rpc` client       |
| Plugin PreCompact hook dormant   | Wired through `host_rpc` correlated callback          |
| `tool.strict` not policy-exposed | Public `ToolStrictPolicy` with preflight              |
| No session annotation API        | `appendAnnotation()` → `content-part/custom` envelope |

## 5. Rejected Duplicates

### Provider Wire Hooks

**Pi proposal:** Raw hook points around HTTP requests to providers (pre-request
header injection, post-response token manipulation, error interception).

**Rejection rationale:** Cognia already provides:

- `chat.middleware` (AI SDK middleware for request/response transforms)
- Stream hooks and token/error lifecycle events
- Diagnostics/tracing (OTel spans for every provider call)
- `customHeaders` on SendOptions (safe header injection)
- Transport header policy (for rate-limit compliance)
- Gateway routing (credential injection without exposing raw requests)

Adding raw provider hooks would:

1. Create a second, competing hook surface for the same use cases
2. Expose provider secrets through hook arguments (security regression)
3. Break the frozen execution spec guarantee (hooks could silently mutate routing)
4. Violate the single-authority principle (two mechanisms → drift)

### Abandoned-Branch Summaries

**Pi proposal:** When a conversation branches, auto-summarize the abandoned branch.

**Rejection rationale:** Cognia retains both branches (`fork`/`clone` in the
canonical session store) with complete lineage (`session.tree()`). There is
nothing to summarize because nothing is abandoned. The Pi design exists because
Pi has no branching model — it loses the branch entirely.

### Fourth Runtime Rail

No gap exists: Pi is Anthropic-only, Cognia already supports Claude SDK,
AI SDK (OpenAI/Google/Mistral/Cohere/etc.), and External agents. Adding a
"Pi-compat" rail would duplicate the Claude SDK rail.

---

## 6. Architecture Alignment Notes

- **Single authority:** `runUnifiedTurn` is the ONE orchestration. The SDK,
  RPC, CLI `run`, and TUI all funnel through it. Pi's `query()` is equivalent
  to a single call to this function.

- **Capability honesty:** The `ResolvedAgentExecutionSpec` carries a
  per-capability `native | equivalent | unsupported` verdict. Pi has no
  equivalent — it silently degrades. Cognia's SDK exposes effective capabilities
  in every `AgentRunResultV1`.

- **Session format stability:** Canonical session version remains 1. No
  migration is needed. Annotations use the existing `content-part/custom`
  envelope kind (already rendered by the fallback path in `message-renderer.tsx`).

---

## 7. Conclusion

Of the features Pi v0.83.0 ships publicly, every one has a Cognia equivalent
(often more capable — branching, multi-provider, capability preflight). The
five genuine gaps (public SDK, RPC, dynamic compaction, strict sampling,
annotations) are filled by this implementation without introducing any new
runtime, transport, session format, compactor, provider adapter, or renderer.
