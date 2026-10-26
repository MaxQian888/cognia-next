// Assertions shared by the real PTY campaign and offline harness regressions.
import assert from "node:assert/strict"

/** A tall paste scrolls its prefix out of the three-line composer viewport. */
export function renderedPaste(text, prompt) {
  const compact = (value) => value.replace(/[\s│█]/g, "")
  if (compact(text).includes(compact(`› ${prompt}`)) || /›.*\[Pasted/.test(text)) return true
  const box = text.lastIndexOf("╭")
  if (box < 0) return false
  const composer = text.slice(box, text.indexOf("╰", box))
  return composer.includes("█") && compact(composer).includes(compact(prompt.slice(-100)))
}

/** Snapshot only the tested TUI's owned process tree, excluding unrelated sessions. */
export function ownedProcessIds(snapshot, rootPid) {
  const pairs = snapshot
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent]) => Number.isInteger(pid) && pid > 0 && Number.isInteger(parent))
  const owned = new Set([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, parent] of pairs) {
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid)
        changed = true
      }
    }
  }
  return [...owned]
}

/** Observe real Chat tool round-trips without saving tool bodies or credentials. */
export function hostToolResults(messages = [], probe = "") {
  const names = new Map()
  const results = []
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name)
    if (message.role !== "tool" || !names.has(message.tool_call_id)) continue
    const content =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    results.push({
      id: message.tool_call_id,
      name: names.get(message.tool_call_id),
      ok: /"ok"\s*:\s*true/.test(content),
      containsProbe: Boolean(probe && content.includes(probe)),
      dismissed: /dismissed/i.test(content),
      selectedAmber: /Selected:.*Amber/i.test(content),
    })
  }
  return results
}

export function successfulStep(name, details, seconds) {
  // Observed product status (e.g. an expected budget "error") cannot replace
  // the acceptance check's own outcome or break its dependency accounting.
  return { ...details, name, status: "passed", seconds }
}

/** A capped final tool result has no subsequent model request to echo its call. */
export function recordedReadPaths(text) {
  return [...text.matchAll(/^\{"tool":"read","input":(\{[^\n]*?\}),"failed":false,/gm)].flatMap(
    (match) => {
      try {
        const input = JSON.parse(match[1])
        const file = input.file_path ?? input.path
        return typeof file === "string" ? [file] : []
      } catch {
        return []
      }
    }
  )
}

export function redactArtifact(value, secret) {
  return String(value).replaceAll(secret, "[REDACTED]")
}

export function toolCalls(messages) {
  return (messages || []).flatMap((m) =>
    (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "tool-call")
  )
}

export function newToolNames(messages, previousIds) {
  return toolCalls(messages)
    .filter((c) => !previousIds.has(c.toolCallId))
    .map((c) => c.toolName)
}

/** Metadata only: never retain request bodies or authentication fields. */
export function requestContextEvidence(messages = []) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => String(m.content))
    .join("\n")
  const text = messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
          : ""
    )
    .join("\n")
  const checkpoints = []
  for (const match of text.matchAll(/<research-progress>\s*([\s\S]*?)\s*<\/research-progress>/g)) {
    try {
      const state = JSON.parse(match[1])
      if (Array.isArray(state.items)) checkpoints.push(state)
    } catch {
      /* Summary instructions can mention tags without a checkpoint. */
    }
  }
  const sourceReads = messages.flatMap((m) =>
    (m.tool_calls || []).flatMap((call) => {
      if (call.function?.name !== "read") return []
      try {
        const args = JSON.parse(call.function.arguments)
        return [
          {
            id: call.id,
            path: args.file_path ?? args.path,
            offset: args.offset,
            limit: args.limit,
          },
        ]
      } catch {
        return []
      }
    })
  )
  return {
    summaryCall:
      messages.length === 2 &&
      messages[0]?.role === "system" &&
      messages[1]?.role === "user" &&
      String(messages[1].content).includes(
        "Summarize the conversation transcript below. It is material to summarize,"
      ) &&
      String(messages[1].content).trimEnd().endsWith("</transcript>"),
    agentRole: system.includes("You are the Explore subagent")
      ? "Explore"
      : system.includes("You are the Plan subagent")
        ? "Plan"
        : "main-or-summary",
    hasSummary: /<conversation-summary\b/.test(text),
    checkpoints,
    sourceReads,
    resumedChild:
      text.includes("You previously worked on this task:\n") && text.includes("Your result was:\n"),
  }
}

/** A discarded speculative summary is cancelled when its owning turn finishes. */
export function completedInferenceEvidence(requests) {
  let cancelledSummaries = 0
  for (const row of requests) {
    const cancelledSummary =
      row.summaryCall === true &&
      row.cancelled === true &&
      row.error === "aborted" &&
      !row.streamError &&
      !row.toolNames?.length
    assert.equal(row.status, 200, "inference must receive HTTP 200")
    assert.ok(
      cancelledSummary || (row.completed && !row.error && !row.streamError),
      "required inference must complete; only a cancelled speculative summary is exempt"
    )
    if (cancelledSummary) cancelledSummaries++
  }
  return { cancelledSummaries }
}

export function projectRecallEvidence(answer, tests) {
  const blocks = [...answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  assert.ok(blocks.length <= 1, "recall must not contain competing JSON reports")
  const json = (blocks[0]?.[1] ?? answer).trim()
  const state = JSON.parse(json)
  assert.equal(state.entry, "src/cli.mjs")
  assert.equal(state.tests, tests)
  assert.deepEqual(state.completed, {
    csvImport: true,
    atomicPersistence: true,
    idempotentImport: true,
  })
  assert.deepEqual(state.pending, [])
  return state
}

export function sourceCorrectionEvidence(answer, { obsolete, revised }) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const correction = new RegExp(
    `^(?:Explicit supersede:\\s*)?Source correction(?:\\s*\\([^)]*\\))?:\\s*${escape(obsolete)}\\s*(?:->|→)\\s*${escape(revised)}(?:[\\s.,;—]|$)`
  )
  assert.ok(
    answer
      .split("\n")
      .some((line) => correction.test(line.replaceAll("`", "").replaceAll("**", "").trim())) ||
      sourceFindingArrays(answer).some((rows) =>
        rows.some(
          (row) =>
            row?.code === revised &&
            typeof row.behavior === "string" &&
            new RegExp(`\\bsupersedes\\s+${escape(obsolete)}(?:[\\s.;,)]|$)`, "i").test(
              row.behavior
            )
        )
      ),
    "report must explicitly replace the obsolete source fact with the observed revision"
  )
  return true
}

export function createSourceReadObserver() {
  const calls = new Map()
  return {
    observe(delta) {
      if (!Number.isInteger(delta.index) || delta.index < 0) return
      const call = calls.get(delta.index) ?? { id: "", function: { name: "", arguments: "" } }
      if (delta.id) call.id = delta.id
      call.function.name += delta.function?.name || ""
      call.function.arguments += delta.function?.arguments || ""
      calls.set(delta.index, call)
    },
    reads() {
      return requestContextEvidence([
        { role: "assistant", tool_calls: [...calls.values()].filter((call) => call.id) },
      ]).sourceReads
    },
  }
}

function sourceFindingArrays(answer) {
  const payloads = [
    ...[...answer.matchAll(/<source-findings>\s*([\s\S]*?)\s*<\/source-findings>/g)].map((match) =>
      match[1].split("<source-findings>").at(-1)
    ),
    ...(/source-findings/i.test(answer)
      ? [...answer.matchAll(/```json\s*([\s\S]*?)\s*```/g)].map((match) => match[1])
      : []),
  ]
  return payloads.flatMap((payload) => {
    try {
      const value = JSON.parse(payload.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""))
      return Array.isArray(value) ? [value] : []
    } catch {
      return []
    }
  })
}

export function sourceFindingEvidence(answer, manifest) {
  const arrays = sourceFindingArrays(answer)
  const rows =
    arrays.find((value) =>
      manifest.every((page) => value.some((row) => row?.code === page.fact))
    ) ?? arrays[0]
  assert.ok(rows, "report must contain structured source-backed behavior rows")
  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, manifest.length, "one behavior row is required for each source")
  for (const page of manifest) {
    const found = rows.filter((row) => row.code === page.fact)
    assert.equal(found.length, 1, `missing or repeated behavior for ${page.fact}`)
    const row = found[0]
    assert.ok(typeof row.behavior === "string" && row.behavior.length >= 20)
    assert.doesNotMatch(
      row.behavior,
      /not retained|not captured|no retained|inferred from|\b(?:behavior|finding|details?|semantics?)\s+(?:(?:is|are|remains?)\s+)?(?:unknown|unchanged)\b|^\s*(?:unknown|unchanged)[.!]?\s*$/i,
      "evidence codes cannot substitute for retained behavior"
    )
    assert.ok(
      typeof row.source === "string" &&
        row.source.includes(page.file) &&
        row.source.includes(`${page.source}:`),
      "each behavior must retain copied and original source citations"
    )
  }
  return rows
}

export function freshCommandResult({ text, revision, before, command, pattern }) {
  const compact = (v) => v.replace(/\s+/g, "")
  return revision > before && !compact(text).includes(compact(`› ${command}`)) && pattern.test(text)
}

export function completedSubagentResult(text, id, expected) {
  const marker = `Subagent "${id}"`
  const at = text.lastIndexOf(marker)
  assert.ok(at >= 0, "new subagent result must be visible")
  const result = text.slice(at + marker.length)
  assert.match(
    result,
    /^(?:  \([^\n]*\))?:\s/,
    "subagent must settle successfully, not fail or remain pending"
  )
  const suffix = /^  \(([^\n]*)\):/.exec(result)?.[1]
  if (suffix)
    assert.match(
      suffix,
      /^(?:\d+ tok(?: · (?:stop|end_turn))?|stop|end_turn)$/,
      "non-success terminal reason is incomplete"
    )
  assert.ok(result.includes(expected), "expected source fact must belong to this subagent result")
  return result
}
