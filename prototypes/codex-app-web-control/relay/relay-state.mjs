const COGNIA_ID_PREFIX = "cognia:"

function requestKey(id) {
  return `${typeof id}:${String(id)}`
}

function bounded(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > 6000 ? `${value.slice(0, 6000)}\n… [truncated]` : value
  }
  if (value === null || typeof value !== "object") return value
  if (depth >= 6) return "[max depth]"
  if (Array.isArray(value)) return value.slice(0, 40).map((entry) => bounded(entry, depth + 1))
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 60)
      .map(([key, entry]) => [key, bounded(entry, depth + 1)])
  )
}

function threadFromResult(result, fallbackThreadId = null) {
  const thread = result?.thread
  return {
    id: thread?.id ?? fallbackThreadId,
    cwd: thread?.cwd ?? null,
  }
}

export function isCogniaRequestId(id) {
  return typeof id === "string" && id.startsWith(COGNIA_ID_PREFIX)
}

export function createCogniaRequestId() {
  return `${COGNIA_ID_PREFIX}${crypto.randomUUID()}`
}

export function isExpectedBrowserSmokeAnswer(answer, code) {
  return typeof answer === "string" && answer.trim() === `BROWSER_OK:${code}`
}

export function createRelayState() {
  return {
    phase: "starting",
    initialized: false,
    appConnected: true,
    activeThreadId: null,
    activeThreadCwd: null,
    activeTurnId: null,
    pendingAppRequests: new Map(),
    eventSequence: 0,
    events: [],
  }
}

export function appendRelayEvent(state, source, message) {
  const event = {
    sequence: ++state.eventSequence,
    at: new Date().toISOString(),
    source,
    method: message?.method ?? (message?.error ? "response/error" : "response"),
    id: message?.id ?? null,
    params: bounded(message?.params ?? message?.result ?? message?.error ?? null),
  }
  state.events.push(event)
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300)
  return event
}

export function observeAppMessage(state, message) {
  if (message?.method === "initialized" && message.id == null) {
    state.initialized = true
    state.phase = "ready"
  }

  if (message?.method && message.id != null) {
    state.pendingAppRequests.set(requestKey(message.id), {
      method: message.method,
      params: bounded(message.params ?? {}),
    })
    if (message.method === "turn/start") {
      state.activeThreadId = message.params?.threadId ?? state.activeThreadId
    }
  }

  appendRelayEvent(state, "app", message)
}

function observeAppResponse(state, message) {
  const pending = state.pendingAppRequests.get(requestKey(message.id))
  if (!pending) return
  state.pendingAppRequests.delete(requestKey(message.id))
  if (message.error) return

  if (pending.method === "initialize") {
    // Codex Desktop starts issuing normal App Server requests as soon as the
    // initialize response succeeds. Some builds do not emit a separate
    // `initialized` notification, so the response is the authoritative gate.
    state.initialized = true
    state.phase = "ready"
  } else if (["thread/start", "thread/resume", "thread/fork"].includes(pending.method)) {
    const thread = threadFromResult(message.result, pending.params?.threadId ?? null)
    state.activeThreadId = thread.id ?? state.activeThreadId
    state.activeThreadCwd = thread.cwd ?? state.activeThreadCwd
  } else if (
    pending.method === "thread/unsubscribe" &&
    pending.params?.threadId === state.activeThreadId
  ) {
    state.activeThreadId = null
    state.activeThreadCwd = null
    state.activeTurnId = null
  }
}

function observeNotification(state, message) {
  const params = message.params ?? {}
  if (message.method === "thread/started") {
    state.activeThreadId = params.thread?.id ?? params.threadId ?? state.activeThreadId
    state.activeThreadCwd = params.thread?.cwd ?? state.activeThreadCwd
  } else if (message.method === "turn/started") {
    state.activeThreadId = params.threadId ?? state.activeThreadId
    state.activeTurnId = params.turn?.id ?? params.turnId ?? state.activeTurnId
  } else if (message.method === "turn/completed") {
    if (!params.threadId || params.threadId === state.activeThreadId) state.activeTurnId = null
  } else if (message.method === "thread/closed") {
    if (params.threadId === state.activeThreadId) {
      state.activeThreadId = null
      state.activeThreadCwd = null
      state.activeTurnId = null
    }
  }
}

export function routeServerMessage(state, message) {
  if (message?.id != null && !message.method && isCogniaRequestId(message.id)) {
    appendRelayEvent(state, "cognia-response", message)
    return { forwardToApp: false, cogniaResponseId: message.id, event: null }
  }

  if (message?.id != null && !message.method) observeAppResponse(state, message)
  if (message?.method && message.id == null) observeNotification(state, message)

  const event = appendRelayEvent(
    state,
    message?.method && message.id != null ? "server-request" : "server",
    message
  )
  return { forwardToApp: true, cogniaResponseId: null, event }
}

export function publicRelayState(state, extra = {}) {
  return {
    phase: state.phase,
    initialized: state.initialized,
    appConnected: state.appConnected,
    activeThreadId: state.activeThreadId,
    activeThreadCwd: state.activeThreadCwd,
    activeTurnId: state.activeTurnId,
    pendingAppRequestCount: state.pendingAppRequests.size,
    events: state.events,
    ...extra,
  }
}
