/**
 * Logger Context
 * Manages session ID, trace ID, and context propagation
 */

/**
 * Generate a unique 32-char hex ID. Used both as the per-tab session ID and as
 * the canonical trace ID — Cognia's logger originally pulled the trace-ID
 * generator from the agent-trace module, but cognia-next has no agent-trace
 * subsystem, so we generate locally with the same shape (UUIDv4 minus hyphens).
 */
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }

  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")
}

/**
 * Global logger context
 */
class LoggerContext {
  private _sessionId: string
  private _traceId: string | undefined
  private _context: Record<string, unknown> = {}
  private _spanStack: string[] = []

  constructor() {
    this._sessionId = this.initSessionId()
  }

  /**
   * Initialize or restore session ID
   */
  private initSessionId(): string {
    if (typeof window === "undefined") {
      return generateId()
    }

    const stored = sessionStorage.getItem("cognia-log-session-id")
    if (stored) {
      return stored
    }

    const newId = generateId()
    sessionStorage.setItem("cognia-log-session-id", newId)
    return newId
  }

  /**
   * Get current session ID
   */
  get sessionId(): string {
    return this._sessionId
  }

  /**
   * Get current trace ID
   */
  get traceId(): string | undefined {
    return this._traceId
  }

  /**
   * Set trace ID for current request chain
   */
  setTraceId(traceId: string): void {
    this._traceId = traceId
  }

  /**
   * Generate and set a new trace ID
   */
  newTraceId(): string {
    this._traceId = generateId()
    return this._traceId
  }

  /**
   * Clear current trace ID
   */
  clearTraceId(): void {
    this._traceId = undefined
  }

  /**
   * Get global context
   */
  get context(): Record<string, unknown> {
    return { ...this._context }
  }

  /**
   * Set global context values
   */
  setContext(context: Record<string, unknown>): void {
    this._context = { ...this._context, ...context }
  }

  /**
   * Clear global context
   */
  clearContext(): void {
    this._context = {}
  }

  /**
   * Current (innermost) span ID, or undefined when no span is active.
   */
  get spanId(): string | undefined {
    return this._spanStack[this._spanStack.length - 1]
  }

  /**
   * Parent span ID of the current span (the enclosing span), if any.
   */
  get parentSpanId(): string | undefined {
    return this._spanStack[this._spanStack.length - 2]
  }

  /**
   * Run a function inside a new span. Logs emitted within `fn` carry the new
   * `spanId` (and `parentSpanId` when nested). The span is always popped,
   * even if `fn` throws. The generated span ID is passed to `fn`.
   */
  withSpan<T>(fn: (spanId: string) => T): T {
    const spanId = generateId()
    this._spanStack.push(spanId)
    try {
      return fn(spanId)
    } finally {
      this._spanStack.pop()
    }
  }

  /**
   * Async variant of {@link withSpan}.
   */
  async withSpanAsync<T>(fn: (spanId: string) => Promise<T>): Promise<T> {
    const spanId = generateId()
    this._spanStack.push(spanId)
    try {
      return await fn(spanId)
    } finally {
      this._spanStack.pop()
    }
  }

  /**
   * Run a function with a specific trace ID
   */
  withTrace<T>(fn: () => T): T {
    const prevTrace = this._traceId
    this._traceId = generateId()
    try {
      return fn()
    } finally {
      this._traceId = prevTrace
    }
  }

  /**
   * Run an async function with a specific trace ID
   */
  async withTraceAsync<T>(fn: () => Promise<T>): Promise<T> {
    const prevTrace = this._traceId
    this._traceId = generateId()
    try {
      return await fn()
    } finally {
      this._traceId = prevTrace
    }
  }
}

/**
 * Singleton logger context instance
 */
export const logContext = new LoggerContext()

/**
 * Generate a new trace ID
 */
export function generateTraceId(): string {
  return generateId()
}

/**
 * Trace ID decorator for async functions
 */
export function traced<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    return logContext.withTraceAsync(() => fn(...args)) as Promise<TResult>
  }
}
