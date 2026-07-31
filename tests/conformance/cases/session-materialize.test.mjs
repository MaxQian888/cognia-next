// Canonical → runtime MATERIALIZATION conformance (ADR-0090 Phase 8).
//
// Proves the CONTEXTUAL materialization path end-to-end with the REAL SDK:
// a canonical session (imported from another runtime — codex in the
// fixture) is materialized as a claude-code session by seeding a NEW native
// session with the replay prompt. The prompt text is pinned BYTE-EXACT on
// the TS side (lib/session-import/codec-types.test.ts asserts
// buildReplayPrompt(session) === fixture.replayPrompt), so this case and
// the codec cannot drift apart silently.
//
// The scenario is case-local (NOT registered in the frozen certification
// suite — suite membership is hash-pinned and version-bumped separately).

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createConformanceServer } from "../anthropic-server/server.mjs"
import { bufferedMessage, textReplyFrames } from "../anthropic-server/sse.mjs"
import { spawnSidecar, assistantText } from "../harness/sidecar-process.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(path.join(HERE, "..", "fixtures", "session-materialize-replay.json"), "utf8")
)

const MODEL = "claude-opus-4-8"

/** Buffered non-stream body for CLI probe calls, SSE frames for the turn. */
function replyPlan({ body, messageId, text }) {
  if (body?.stream === true) {
    return { sseFrames: textReplyFrames({ messageId, model: MODEL, text }) }
  }
  return { body: bufferedMessage({ messageId, model: MODEL, text }) }
}

function flattenMessages(body) {
  return JSON.stringify(body?.messages ?? [])
}

function materializeScenario() {
  return {
    id: "session-materialize",
    steps: [
      {
        name: "the materialized turn must carry the imported transcript verbatim",
        matches: ({ body }) => {
          const flat = flattenMessages(body)
          return (
            flat.includes("How do I port the parser?") &&
            flat.includes("Start with the lexer.") &&
            flat.includes("Continue the conversation from this point.")
          )
        },
        respond: ({ body, hit }) =>
          replyPlan({
            body,
            messageId: `msg_conf_materialize_${hit}`,
            text: "continuing from the imported parser context",
          }),
      },
      {
        // Auxiliary CLI traffic (probes, title generation) — neutral reply.
        respond: ({ body, hit }) =>
          replyPlan({ body, messageId: `msg_conf_materialize_aux_${hit}`, text: "aux" }),
      },
    ],
  }
}

test(
  "canonical history materializes into a NEW claude-code session via the replay prompt",
  { timeout: 180_000 },
  async () => {
    const { server, baseUrl } = await createConformanceServer(materializeScenario())
    const sidecar = spawnSidecar({ baseUrl, apiKey: "sk-conf-materialize" })
    try {
      await sidecar.waitFor((m) => m.type === "ready", { label: "ready" })
      // The EXACT prompt the claude-code codec's contextual materialize
      // produces (pinned on the TS side). A brand-new session id — never the
      // canonical/native id of the source runtime.
      sidecar.send({
        type: "send",
        sessionId: "conf-materialize",
        prompt: fixture.replayPrompt,
        options: { model: MODEL, maxTurns: 4 },
      })
      const sid = await sidecar.waitFor((m) => m.type === "sdk_session_id", {
        label: "sdk_session_id",
        timeoutMs: 90_000,
      })
      const assistant = await sidecar.waitFor(
        (m) => m.type === "event" && m.event?.type === "assistant",
        { label: "assistant", timeoutMs: 90_000 }
      )
      await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
        label: "result",
        timeoutMs: 90_000,
      })

      // The turn matched the transcript-verbatim step (fail-closed server:
      // an unmatched main turn would have produced an error, not this text).
      assert.match(assistantText(assistant), /continuing from the imported parser context/)
      // Contextual — the runtime minted its OWN session id; the canonical
      // record's source-runtime identity never leaks into the new session.
      assert.ok(sid.sdkSessionId && sid.sdkSessionId.length > 0)
      assert.ok(!fixture.replayPrompt.includes(sid.sdkSessionId))
    } finally {
      await sidecar.close()
      await server.close()
    }
  }
)
