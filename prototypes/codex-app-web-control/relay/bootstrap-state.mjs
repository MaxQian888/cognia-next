const MARKER_PREFIX = "[COGNIA_BOOTSTRAP:"
const TERMINAL_STATUSES = new Set(["completed", "failed", "passed"])

function requestKey(id) {
  return `${typeof id}:${String(id)}`
}

function markerFor(nonce) {
  return `${MARKER_PREFIX}${nonce}]`
}

function messageContainsNonce(message, nonce) {
  try {
    return JSON.stringify(message?.params?.input ?? []).includes(markerFor(nonce))
  } catch {
    return false
  }
}

function errorText(item) {
  if (item?.error) return String(item.error)
  if (!Array.isArray(item?.result?.content)) return "Tool call failed"
  return item.result.content
    .filter((entry) => entry?.type === "text")
    .map((entry) => entry.text)
    .join("\n")
    .slice(0, 4000)
}

export function createBootstrapTracker({ onChange = () => {} } = {}) {
  const records = []
  const pendingTurnRequests = new Map()

  function changed(record) {
    record.updatedAt = new Date().toISOString()
    onChange(record)
    return record
  }

  function begin({ nonce, expectedAnswer, browserUrl }) {
    if (records.some((record) => !TERMINAL_STATUSES.has(record.status))) {
      throw new Error("A Codex App bootstrap is already active")
    }
    const now = new Date().toISOString()
    const record = {
      nonce,
      status: "opening",
      expectedAnswer,
      browserUrl,
      deepLink: null,
      rendererId: null,
      submission: null,
      threadId: null,
      turnId: null,
      finalAnswer: null,
      browserVerified: expectedAnswer == null ? null : false,
      toolErrors: [],
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    records.push(record)
    if (records.length > 20) records.splice(0, records.length - 20)
    onChange(record)
    return record
  }

  function find(nonce) {
    return records.findLast((record) => record.nonce === nonce) ?? null
  }

  function markUiSubmitted(nonce, result) {
    const record = find(nonce)
    if (!record) return null
    if (record.status === "opening") record.status = "submitted"
    record.deepLink = result.deepLink
    record.rendererId = result.rendererId
    record.submission = result.submission
    return changed(record)
  }

  function fail(nonce, error) {
    const record = find(nonce)
    if (!record) return null
    record.status = "failed"
    record.error = error instanceof Error ? error.message : String(error)
    record.completedAt = new Date().toISOString()
    return changed(record)
  }

  function observeApp(message) {
    if (message?.method !== "turn/start" || message.id == null) return null
    const record = records.findLast(
      (candidate) =>
        candidate.threadId == null &&
        !["failed", "passed"].includes(candidate.status) &&
        messageContainsNonce(message, candidate.nonce)
    )
    if (!record) return null
    record.threadId = message.params?.threadId ?? record.threadId
    record.status = "bound"
    pendingTurnRequests.set(requestKey(message.id), record.nonce)
    return changed(record)
  }

  function observeServer(message) {
    if (message?.id != null && !message.method) {
      const nonce = pendingTurnRequests.get(requestKey(message.id))
      if (nonce) {
        pendingTurnRequests.delete(requestKey(message.id))
        const record = find(nonce)
        if (!record) return null
        if (message.error) return fail(nonce, message.error.message ?? "turn/start failed")
        record.turnId = message.result?.turn?.id ?? record.turnId
        record.status = "running"
        return changed(record)
      }
    }

    const params = message?.params ?? {}
    const record = records.findLast(
      (candidate) =>
        candidate.threadId &&
        candidate.threadId === params.threadId &&
        (!candidate.turnId ||
          candidate.turnId === params.turnId ||
          candidate.turnId === params.turn?.id)
    )
    if (!record) return null

    if (message.method === "turn/started") {
      record.turnId = params.turn?.id ?? params.turnId ?? record.turnId
      record.status = "running"
      return changed(record)
    }
    if (message.method === "item/completed") {
      const item = params.item ?? {}
      if (item.type === "agentMessage" && item.phase === "final_answer") {
        record.finalAnswer = typeof item.text === "string" ? item.text : ""
      } else if (item.type === "mcpToolCall" && item.status === "failed") {
        record.toolErrors = [
          ...record.toolErrors,
          { server: item.server ?? null, tool: item.tool ?? null, message: errorText(item) },
        ].slice(-10)
      }
      return changed(record)
    }
    if (message.method === "turn/completed") {
      record.completedAt = new Date().toISOString()
      if (record.expectedAnswer == null) {
        record.status = "completed"
        return changed(record)
      }
      record.browserVerified =
        typeof record.finalAnswer === "string" &&
        record.finalAnswer.trim() === record.expectedAnswer
      record.status = record.browserVerified ? "passed" : "failed"
      if (!record.browserVerified && !record.error) {
        record.error = "The App-originated turn did not return the exact Browser verification code"
      }
      return changed(record)
    }
    return null
  }

  return {
    begin,
    fail,
    find,
    latest: () => records.at(-1) ?? null,
    list: () => [...records],
    markUiSubmitted,
    observeApp,
    observeServer,
  }
}
