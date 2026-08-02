/**
 * Dexie → durability capture: turn every committed Dexie transaction into one
 * {@link DurabilityCommit}.
 *
 * Where the commit point is, and why:
 *
 * IndexedDB transactions auto-commit; there is no hook that can `await` between
 * "the store accepted the writes" and "the caller's promise resolves". The one
 * place that sits inside that gap is the transaction's `complete` **event
 * listener**, dispatched before Dexie's own `oncomplete` resolves the
 * transaction promise — because this middleware registers its listener when the
 * DBCore transaction is created, strictly before Dexie assigns `oncomplete`.
 * So the journal append runs there, synchronously (`writeSync` + `fsyncSync`),
 * and a transaction that resolved to the caller is always already on disk.
 *
 * Mutations are recorded **synchronously** whenever the key is knowable up
 * front (`req.keys`, or the primary key extracted from the value — the shape
 * every inbound-key Cognia table uses). Only auto-generated keys need the
 * response, and those are recorded from the `mutate` continuation, which
 * settles as a microtask off the request's `success` event and therefore still
 * lands before the transaction's `complete` macrotask.
 *
 * `deleteRange` (what `Table.clear()` compiles to) is expanded into explicit
 * key deletions by querying the range first: a range is not replayable against
 * a key/value store, and losing `clear()` would make replay diverge.
 */
import { encodeKey } from "./canonical"
import type { DurabilityMutation } from "./types"

/** Minimal DBCore shapes. Kept structural so tests need no Dexie instance. */
export interface CaptureMutateRequest {
  type: "add" | "put" | "delete" | "deleteRange"
  trans: object
  keys?: unknown[]
  values?: unknown[]
  range?: unknown
  wantResults?: boolean
  [key: string]: unknown
}

export interface CaptureMutateResponse {
  results?: unknown[]
  failures?: Record<number, unknown> | unknown[]
  [key: string]: unknown
}

export interface CaptureTableLike {
  name: string
  schema: { primaryKey: { extractKey?: (value: unknown) => unknown } }
  mutate(req: CaptureMutateRequest): Promise<CaptureMutateResponse>
  query(req: unknown): Promise<{ result: unknown[] }>
  [key: string]: unknown
}

export interface CaptureTransactionLike {
  addEventListener?(type: string, listener: () => void): void
}

export interface CaptureCoreLike {
  table(name: string): CaptureTableLike
  transaction(stores: string[], mode: string, options?: unknown): CaptureTransactionLike
  [key: string]: unknown
}

export interface CaptureDexieLike {
  use(middleware: {
    stack: "dbcore"
    name: string
    create(down: CaptureCoreLike): CaptureCoreLike
  }): unknown
}

export interface CaptureOptions {
  /** Dexie database name — the `DurabilityMutation.database` value. */
  database: string
  /** Tables deliberately not persisted (mirrors the snapshot exclusions). */
  excludeTables?: readonly string[]
  /**
   * Durably record one transaction. Runs on the `complete` listener and MUST
   * be synchronous; throwing here surfaces as an unhandled event-listener
   * error, which is the correct outcome — a brain that cannot journal must not
   * keep serving as if it could.
   */
  onCommit: (mutations: DurabilityMutation[]) => void
}

export interface CaptureHandle {
  /**
   * Run `fn` with capture suspended.
   *
   * Restore replays persisted rows back into Dexie; journaling that replay
   * would double every row and desynchronise the sequence.
   */
  suppress<T>(fn: () => Promise<T>): Promise<T>
  /** Whether capture is currently suspended (diagnostics/tests). */
  isSuppressed(): boolean
}

/**
 * Install the capture middleware. MUST be called before Dexie opens — `db.use`
 * only records the middleware, and the DBCore stack is generated at open time,
 * so a post-open `use()` is inert until a reopen.
 */
export function installTransactionCapture(
  db: CaptureDexieLike,
  opts: CaptureOptions
): CaptureHandle {
  const excluded = new Set(opts.excludeTables ?? [])
  const pending = new WeakMap<object, DurabilityMutation[]>()
  let suppressed = 0

  function record(trans: object, mutation: DurabilityMutation): void {
    if (suppressed > 0) return
    const list = pending.get(trans)
    if (list) list.push(mutation)
    else pending.set(trans, [mutation])
  }

  function flush(trans: object): void {
    const mutations = pending.get(trans)
    pending.delete(trans)
    if (!mutations || mutations.length === 0) return
    if (suppressed > 0) return
    opts.onCommit(mutations)
  }

  db.use({
    stack: "dbcore",
    name: "headless-durability-capture",
    create(down) {
      return {
        ...down,
        transaction(stores: string[], mode: string, options?: unknown) {
          const trans = down.transaction(stores, mode, options)
          if (mode === "readwrite" || mode === "versionchange") {
            trans.addEventListener?.("complete", () => flush(trans))
            trans.addEventListener?.("abort", () => pending.delete(trans))
            trans.addEventListener?.("error", () => pending.delete(trans))
          }
          return trans
        },
        table(name: string) {
          const table = down.table(name)
          if (excluded.has(name)) return table
          return wrapTable(table, name)
        },
      }
    },
  })

  function wrapTable(table: CaptureTableLike, name: string): CaptureTableLike {
    return {
      ...table,
      mutate(req: CaptureMutateRequest) {
        if (suppressed > 0) return table.mutate(req)
        if (req.type === "deleteRange") return mutateRange(table, name, req)
        if (req.type === "delete") {
          for (const key of req.keys ?? []) {
            record(req.trans, {
              database: opts.database,
              table: name,
              key: encodeKey(key),
              value: null,
            })
          }
          return table.mutate(req)
        }
        return mutateWrite(table, name, req)
      },
    }
  }

  function mutateWrite(
    table: CaptureTableLike,
    name: string,
    req: CaptureMutateRequest
  ): Promise<CaptureMutateResponse> {
    const values = req.values ?? []
    const extract = table.schema.primaryKey.extractKey
    const knownKeys: unknown[] = req.keys ?? (extract ? values.map((value) => extract(value)) : [])
    const complete = knownKeys.length === values.length && knownKeys.every((k) => k !== undefined)

    if (complete) {
      // Synchronous path: the key is known before the request is issued, so the
      // record cannot race the transaction's `complete` dispatch.
      for (let index = 0; index < values.length; index += 1) {
        record(req.trans, {
          database: opts.database,
          table: name,
          key: encodeKey(knownKeys[index]),
          value: values[index] ?? null,
        })
      }
      return table.mutate(req)
    }

    // Auto-generated keys: ask DBCore to return them, then record from the
    // continuation (a microtask off `success`, still ahead of `complete`).
    return table.mutate({ ...req, wantResults: true }).then((response) => {
      const results = response.results ?? []
      const failures = normaliseFailures(response.failures)
      for (let index = 0; index < values.length; index += 1) {
        if (failures.has(index)) continue
        const key = results[index] ?? knownKeys[index]
        if (key === undefined) continue
        record(req.trans, {
          database: opts.database,
          table: name,
          key: encodeKey(key),
          value: values[index] ?? null,
        })
      }
      return response
    })
  }

  function mutateRange(
    table: CaptureTableLike,
    name: string,
    req: CaptureMutateRequest
  ): Promise<CaptureMutateResponse> {
    return table
      .query({
        trans: req.trans,
        values: false,
        limit: Infinity,
        query: { index: table.schema.primaryKey, range: req.range },
      })
      .then((found) => {
        for (const key of found.result ?? []) {
          record(req.trans, {
            database: opts.database,
            table: name,
            key: encodeKey(key),
            value: null,
          })
        }
        return table.mutate(req)
      })
  }

  return {
    async suppress(fn) {
      suppressed += 1
      try {
        return await fn()
      } finally {
        suppressed -= 1
      }
    },
    isSuppressed: () => suppressed > 0,
  }
}

function normaliseFailures(failures: CaptureMutateResponse["failures"]): Set<number> {
  const set = new Set<number>()
  if (!failures) return set
  for (const key of Object.keys(failures)) {
    const index = Number(key)
    if (Number.isInteger(index)) set.add(index)
  }
  return set
}
