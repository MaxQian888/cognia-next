/**
 * Coalescing queue in front of `codeserver_open_file`.
 *
 * Every open/reveal currently spawns a fresh `code-server --reuse-window` CLI
 * child, i.e. a full Node cold start. Agent auto-follow
 * (`hooks/agent/use-agent-file-auto-follow.ts`) fires one per tool call with no
 * rate limit of its own, so a burst of agent file reads would otherwise launch a
 * process storm and the editor would chase stale targets long after the agent
 * moved on.
 *
 * Policy: last-write-wins. A newer request replaces any queued one, at most one
 * call is ever in flight, and intermediate targets are dropped — the user only
 * ever wants to land on the most recent file.
 *
 * This stays in place once W3's companion-extension channel lands: it becomes
 * the degraded path used when the extension isn't active.
 */

export interface CodeServerOpenTarget {
  path: string
  line?: number
  column?: number
}

export interface CodeServerOpenQueue {
  /** Request an open; supersedes any target still waiting to be sent. */
  request: (path: string, line?: number, column?: number) => void
  /** Drop pending work (does not cancel a call already in flight). */
  dispose: () => void
}

export interface CodeServerOpenQueueOptions {
  /** Quiet period before the latest target is sent. Defaults to 150ms. */
  delayMs?: number
  /** Called with whatever `open` rejected with. */
  onError?: (cause: unknown) => void
}

/**
 * Wrap `open` in a last-write-wins debounce with single-flight serialization.
 */
export function createCodeServerOpenQueue(
  open: (path: string, line?: number, column?: number) => Promise<void>,
  options: CodeServerOpenQueueOptions = {}
): CodeServerOpenQueue {
  const delayMs = options.delayMs ?? 150
  let pending: CodeServerOpenTarget | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let disposed = false

  const flush = () => {
    timer = null
    if (disposed || inFlight || !pending) return
    const target = pending
    pending = null
    inFlight = true
    void open(target.path, target.line, target.column)
      .catch((cause) => options.onError?.(cause))
      .finally(() => {
        inFlight = false
        // A request that arrived mid-flight is sent as soon as we're free.
        if (pending) flush()
      })
  }

  return {
    request: (path, line, column) => {
      if (disposed) return
      pending = { path, line, column }
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    dispose: () => {
      disposed = true
      pending = null
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
