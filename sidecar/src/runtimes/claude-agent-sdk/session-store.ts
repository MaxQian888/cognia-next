// The live `SessionStore` object the Claude Agent SDK wants, backed by the
// Rust host over `host_rpc` (ADR-0090 SDK-parity plan, Stage 4).
//
// The SDK's `sessionStore` option is an object with methods, so it cannot ride
// the JSON wire from the renderer — `SendOptions.claudeAgentSdk.sessionStore`
// carries only a DESCRIPTOR (`{ backend: "host-sqlite", flush }`) and this
// module turns that into the real thing. Everything it does lands in
// `src-tauri/src/agent_session_store/`, which answers `host_rpc` directly, so
// the store works identically on the desktop, under `cognia-server` (no
// renderer at all), and when a phone is driving the desktop.
//
// Two things here are subtler than they look:
//
//   * **Summaries are folded HERE and stored there.** `foldSessionSummary` is a
//     pure function the SDK ships in JavaScript; Rust cannot call it. So the
//     read-fold-write the SDK requires to be atomic is split across a process
//     boundary, and the host's version counter is what closes the gap — see
//     `writeSummary`'s CAS below.
//   * **Appends for one session are serialised in-process.** The SDK batches at
//     ~100ms during a turn and `flush: "eager"` makes every frame its own
//     batch, so two appends for the same session are routinely in flight at
//     once. Without the chain their folds would race and one would be lost.

import type {
  SessionKey,
  SessionStoreEntry,
  SessionSummaryEntry,
} from "@anthropic-ai/claude-agent-sdk"
import type { HostRpcCaller } from "../../tools/state/host-background-shells.ts"
import { foldSessionSummary } from "@anthropic-ai/claude-agent-sdk"

/** How many times a losing CAS re-reads and re-folds before giving up. */
export const SUMMARY_CAS_ATTEMPTS = 5

/**
 * Stable string for one session key, used to key the serialisation chain.
 *
 * NUL-separated because it is the one byte that cannot appear in a
 * `projectKey` (a sanitized cwd) or a session id, so `{a, b|c}` and `{a|b, c}`
 * can never collapse onto one chain and serialise two unrelated sessions
 * against each other.
 */
export function sessionChainKey(key: SessionKey | undefined) {
  return `${key?.projectKey ?? ""}\u0000${key?.sessionId ?? ""}`
}

/**
 * Run `task` after every task already queued for `chainKey`.
 *
 * A plain map of promises, not a lock library: the chain is per session and
 * lives exactly as long as the session's traffic, and a rejected task must not
 * poison the queue for the next one (hence the `.catch` before chaining).
 *
 */
export function serialize<T>(
  chains: Map<string, Promise<unknown>>,
  chainKey: string,
  task: () => Promise<T>
) {
  const previous = chains.get(chainKey) ?? Promise.resolve()
  const next = previous.then(task, task)
  // Keep the map from growing one entry per session for the process lifetime:
  // drop it once this task is the last one queued. The identity check is
  // against `settled` — the value actually stored — not against `next`, which
  // is only what callers await.
  const forget = () => {
    if (chains.get(chainKey) === settled) chains.delete(chainKey)
  }
  const settled = next.then(forget, forget)
  chains.set(chainKey, settled)
  return next
}

/**
 * Build the SDK-facing store.
 *
 */
export interface SessionStoreDeps {
  hostRpc: HostRpcCaller
  scope?: { tenant?: string; workspace?: string }
  log?: (level: "warn", message: string) => void
  foldSummary?: typeof foldSessionSummary
}
interface StoreReply {
  summary?: (SessionSummaryEntry & { version?: number }) | null
  ok?: boolean
  entries?: SessionStoreEntry[] | null
  sessions?: { sessionId: string; mtime: number }[]
  summaries?: SessionSummaryEntry[]
  subkeys?: string[]
}
export interface StoreSendOptions {
  cwd?: string
  execution?: { tenantId?: string; hostRef?: string }
  claudeAgentSdk?: {
    version?: number
    sessionStore?: { backend?: string; workspace?: string | null }
  }
}
export function createHostSessionStore({
  hostRpc,
  scope = {},
  log = () => {},
  foldSummary,
}: SessionStoreDeps) {
  const fold = foldSummary ?? foldSessionSummary
  const chains = new Map<string, Promise<unknown>>()

  const call = async (method: string, params: Record<string, unknown>): Promise<StoreReply> =>
    (await hostRpc.call(`sessionStore.${method}`, { scope, ...params })) as StoreReply

  /**
   * Read the current summary, fold the new entries into it, write it back.
   * Retries on a losing CAS: someone else wrote between our read and our write,
   * so our fold started from state that no longer exists.
   *
   * Failure here is logged, never thrown. The transcript rows are already
   * committed at this point, and turning a summary race into a rejected
   * `append()` would make the SDK retry the whole batch and eventually emit a
   * `mirror_error` — reporting data loss that did not happen.
   */
  async function maintainSummary(key: SessionKey, entries: SessionStoreEntry[]) {
    for (let attempt = 0; attempt < SUMMARY_CAS_ATTEMPTS; attempt += 1) {
      const { summary } = await call("readSummary", {
        projectKey: key.projectKey,
        sessionId: key.sessionId,
      })
      const previous = summary
        ? { sessionId: summary.sessionId, mtime: summary.mtime, data: summary.data }
        : undefined
      // `mtime` is the STORAGE write time and the host stamps it; passing ours
      // would defeat the SDK's staleness check, which compares this against
      // `listSessions()`'s mtime from the same clock.
      const folded = fold(previous, key, entries)
      const result = await call("writeSummary", {
        projectKey: key.projectKey,
        sessionId: key.sessionId,
        data: folded.data,
        expectedVersion: summary?.version,
      })
      if (result?.ok) return
    }
    log(
      "warn",
      `sessionStore: gave up folding the summary for ${key.sessionId} after ` +
        `${SUMMARY_CAS_ATTEMPTS} attempts; listSessions will fall back to load()`
    )
  }

  return {
    /**
     * Mirror a batch. Called AFTER the subprocess's own local write, so this
     * is a copy — durability is already guaranteed on disk.
     */
    async append(key: SessionKey, entries: SessionStoreEntry[] | null) {
      if (!Array.isArray(entries) || entries.length === 0) return
      await serialize(chains, sessionChainKey(key), async () => {
        await call("append", { key, entries })
        // Subagent transcripts are deliberately excluded from the summary: the
        // SDK's fold describes the MAIN conversation, and folding a subagent's
        // entries into it would inflate the parent's counts with turns the user
        // never sees in that thread.
        if (!key?.subpath) await maintainSummary(key, entries)
      })
    },

    /** Load a full transcript for resume. `null` = never written. */
    async load(key: SessionKey) {
      const { entries } = await call("load", { key })
      return entries ?? null
    },

    async listSessions(projectKey: string) {
      const { sessions } = await call("listSessions", { projectKey })
      return sessions ?? []
    },

    /**
     * The single round-trip `listSessions({ sessionStore })` prefers. Entries
     * are returned in the SDK's own shape — the host's `version` is ours and
     * is stripped here rather than leaking into SDK state.
     */
    async listSessionSummaries(projectKey: string) {
      const { summaries } = await call("listSummaries", { projectKey })
      return (summaries ?? []).map(({ sessionId, mtime, data }) => ({ sessionId, mtime, data }))
    },

    async delete(key: SessionKey) {
      await serialize(chains, sessionChainKey(key), () => call("delete", { key }))
    },

    async listSubkeys(key: SessionKey) {
      const { subkeys } = await call("listSubkeys", {
        projectKey: key.projectKey,
        sessionId: key.sessionId,
      })
      return subkeys ?? []
    },
  }
}

/**
 * Build a store from `SendOptions.claudeAgentSdk.sessionStore`, or `null` when
 * the send asked for none.
 *
 * The descriptor's `backend` is an enum on purpose (see the contract): a
 * renderer must not be able to name where session data lands. An unknown
 * backend returns null with a warning rather than falling back to a default —
 * silently persisting somewhere other than the caller asked is worse than not
 * persisting.
 *
 */
export function sessionStoreFromSendOptions(
  sendOptions: StoreSendOptions | undefined,
  { hostRpc, log = () => {} }: { hostRpc?: HostRpcCaller | null; log?: SessionStoreDeps["log"] }
) {
  const descriptor = sendOptions?.claudeAgentSdk?.sessionStore
  if (!descriptor) return null
  if (descriptor.backend !== "host-sqlite") {
    log("warn", `sessionStore: unknown backend "${descriptor.backend}" — persistence is off`)
    return null
  }
  if (!hostRpc) {
    log("warn", "sessionStore: no host_rpc channel on this host — persistence is off")
    return null
  }
  return createHostSessionStore({
    hostRpc,
    scope: storeScope(sendOptions),
    log,
  })
}

/**
 * Tenant + workspace for a send.
 *
 * Read from the FROZEN execution spec, never from the SDK key: the key's
 * `projectKey` is caller-supplied, so deriving isolation from it would let a
 * crafted value cross a boundary. `hostRef` is the coarsest honest tenant a
 * single-tenant desktop has; a multi-tenant deployment sets `tenantId`
 * explicitly and this picks it up without a schema change.
 *
 */
export function storeScope(sendOptions: StoreSendOptions | undefined) {
  const execution = sendOptions?.execution
  const descriptor = sendOptions?.claudeAgentSdk?.sessionStore
  const persistedWorkspace =
    descriptor && Object.hasOwn(descriptor, "workspace") ? descriptor.workspace : undefined
  return {
    tenant: String(execution?.tenantId ?? execution?.hostRef ?? "default"),
    workspace:
      persistedWorkspace === null
        ? "default"
        : String(persistedWorkspace ?? sendOptions?.cwd ?? "default"),
  }
}
