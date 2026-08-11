import fs from "node:fs"
import path from "node:path"

const MAX_AUDIT_BYTES = 10 * 1024 * 1024
const MAX_QUERY_LIMIT = 1_000

export interface RpcAuditEntry {
  id: string
  at: string
  method: string
  sessionId?: string
  durationMs: number
  result: "ok" | "error"
  errorCode?: string | number
}

export interface RpcAuditStore {
  append(entry: RpcAuditEntry): void
  query(options?: { sessionId?: string; cursor?: string; limit?: number }): {
    entries: RpcAuditEntry[]
    nextCursor?: string
  }
  exportTrace(sessionId?: string): { spans: Array<Record<string, unknown>> }
}

export function createRpcAuditStore(home: string): RpcAuditStore {
  const file = path.join(home, "agent-sdk", "audit.jsonl")

  function read(): RpcAuditEntry[] {
    try {
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const value = JSON.parse(line) as RpcAuditEntry
            return value && typeof value.id === "string" && typeof value.method === "string"
              ? [value]
              : []
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  function append(entry: RpcAuditEntry): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size >= MAX_AUDIT_BYTES) {
        fs.renameSync(file, `${file}.1`)
      }
    } catch {
      // A missing audit file is the normal first-write path.
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  function query(options: { sessionId?: string; cursor?: string; limit?: number } = {}): {
    entries: RpcAuditEntry[]
    nextCursor?: string
  } {
    const filtered = read().filter(
      (entry) => options.sessionId === undefined || entry.sessionId === options.sessionId
    )
    const cursor = options.cursor ? filtered.findIndex((entry) => entry.id === options.cursor) : -1
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, options.limit ?? 100))
    const entries = filtered.slice(cursor + 1, cursor + 1 + limit)
    const hasMore = cursor + 1 + entries.length < filtered.length
    return {
      entries,
      ...(hasMore && entries.length > 0 ? { nextCursor: entries.at(-1)!.id } : {}),
    }
  }

  function exportTrace(sessionId?: string): { spans: Array<Record<string, unknown>> } {
    const entries = read().filter(
      (entry) => sessionId === undefined || entry.sessionId === sessionId
    )
    return {
      spans: entries.map((entry) => ({
        traceId: entry.id,
        name: `agent.rpc.${entry.method}`,
        startTime: entry.at,
        durationMs: entry.durationMs,
        status: entry.result,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
      })),
    }
  }

  return { append, query, exportTrace }
}
