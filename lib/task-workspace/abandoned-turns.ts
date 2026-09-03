/**
 * Release a workspace bundle turn whose client went away mid-turn.
 *
 * A managed conversation holds exactly one execution root, and the host refuses
 * a second turn while one is `running` on it. That refusal is right: two turns
 * writing one working copy is the corruption the guard exists to prevent. What
 * was wrong is that nothing ever ended a turn whose client stopped driving it.
 * A page reload during a turn (a dev-server hot reload, a crash, a closed tab)
 * left the run `running` on the host forever, and every later send in that
 * conversation was refused with `pipeline workspace is already active`. The
 * conversation was wedged until the host itself restarted, which is when
 * `recover_incomplete_runs` settles the leftovers.
 *
 * The host cannot tell the two apart. For a locally driven turn the agent runs
 * on the client, so from the host's side an abandoned turn and a long one look
 * identical. Only the clients know, so they are asked.
 *
 * Two facts make that answer trustworthy:
 *
 *   - **What this browser opened is written down.** `localStorage` survives the
 *     reload that loses the in-memory store, so a fresh page still knows which
 *     turn ids the previous one left open.
 *   - **A live tab claims its own.** Every tab holding a turn answers a
 *     `BroadcastChannel` poll with the ids it is still driving. A turn nobody
 *     claims within {@link PEER_REPLY_WINDOW_MS} has no driver, so it is safe
 *     to abort.
 *
 * The poll is scoped to this browser, which is exactly the right scope: another
 * device's turn was never recorded here, so it is never a candidate and a
 * genuine cross-device concurrent turn is still refused, as it should be.
 *
 * This runs on the refusal rather than at boot. The host is demonstrably
 * reachable at that moment, the send path already holds the approval scope that
 * covers `task_workspace_bundle_turn_abort`, and a conversation that is not
 * wedged never pays for any of it.
 */

const STORAGE_KEY = "cognia.taskWorkspace.openBundleTurns"
const CHANNEL_NAME = "cognia.taskWorkspace.bundleTurns"

/**
 * How long a poll waits for live tabs to claim their turns.
 *
 * `BroadcastChannel` delivery is a task hop between same-origin documents, so
 * a live tab answers in a frame or two. The budget is what an unresponsive but
 * live tab is allowed before its turn is treated as abandoned, and it is only
 * ever paid on a send that was already refused.
 */
export const PEER_REPLY_WINDOW_MS = 300

/** How many turn records this browser keeps, newest last. */
const MAX_RECORDS = 32

export interface OpenBundleTurn {
  bundleTurnId: string
  /** The conversation, so a reclaim only considers the one that was refused. */
  sessionId: string
  openedAt: number
}

interface PollMessage {
  kind: "cognia.bundle-turn.poll"
  nonce: string
  bundleTurnIds: string[]
}

interface ClaimMessage {
  kind: "cognia.bundle-turn.claim"
  nonce: string
  bundleTurnIds: string[]
}

/** The turns THIS document is still driving. The answer to any poll. */
const live = new Set<string>()

/** Minimal shapes, so the deps can be faked without a DOM. */
export interface AbandonedTurnChannel {
  postMessage(message: unknown): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  close(): void
}

export interface AbandonedTurnDeps {
  readStorage: () => string | null
  writeStorage: (value: string) => void
  openChannel: () => AbandonedTurnChannel | null
  abort: (bundleTurnId: string) => Promise<unknown>
  now: () => number
  /** Injected so a test does not wait out the real reply window. */
  waitForClaims: (ms: number) => Promise<void>
}

const defaultDeps: AbandonedTurnDeps = {
  readStorage: () => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
    } catch {
      // A browser with site data blocked. The feature degrades to "no records",
      // which means no reclaim, which is the same behaviour as before it.
      return null
    }
  },
  writeStorage: (value) => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value)
    } catch {
      // See above. Losing the record costs a reclaim, never correctness.
    }
  },
  openChannel: () => {
    const Channel = (
      globalThis as { BroadcastChannel?: new (name: string) => AbandonedTurnChannel }
    ).BroadcastChannel
    if (!Channel) return null
    try {
      return new Channel(CHANNEL_NAME)
    } catch {
      return null
    }
  },
  // Imported lazily: `client.ts` calls into this module on its refusal path,
  // and holding a static reference back to it would close the cycle at module
  // scope. The approval this abort needs is already open, because the only
  // caller reaches here from inside `openWorkspaceBundleTurnLease`'s scope,
  // which names `task_workspace_bundle_turn_abort`.
  abort: async (bundleTurnId) => {
    const { abortWorkspaceBundleTurn } = await import("./client")
    return abortWorkspaceBundleTurn(bundleTurnId)
  },
  now: () => Date.now(),
  waitForClaims: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

let deps: AbandonedTurnDeps = defaultDeps

/** Test seam. Returns a restore function. */
export function __setAbandonedTurnDepsForTests(next: Partial<AbandonedTurnDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
    live.clear()
    responder?.stop()
    responder = null
  }
}

function readRecords(): OpenBundleTurn[] {
  const raw = deps.readStorage()
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is OpenBundleTurn =>
        typeof (entry as OpenBundleTurn)?.bundleTurnId === "string" &&
        typeof (entry as OpenBundleTurn)?.sessionId === "string"
    )
  } catch {
    return []
  }
}

function writeRecords(records: OpenBundleTurn[]): void {
  deps.writeStorage(JSON.stringify(records.slice(-MAX_RECORDS)))
}

let responder: { stop: () => void } | null = null

/**
 * Answer other tabs' polls for as long as this one holds a turn.
 *
 * Attached on the first turn rather than at boot, because a document holding
 * nothing has nothing to claim and a silent tab is indistinguishable from an
 * absent one, which is the correct answer for it.
 */
function ensureResponder(): void {
  if (responder) return
  const channel = deps.openChannel()
  if (!channel) return
  const listener = (event: { data: unknown }) => {
    const message = event.data as PollMessage | undefined
    if (message?.kind !== "cognia.bundle-turn.poll") return
    const claimed = message.bundleTurnIds.filter((id) => live.has(id))
    if (claimed.length === 0) return
    const reply: ClaimMessage = {
      kind: "cognia.bundle-turn.claim",
      nonce: message.nonce,
      bundleTurnIds: claimed,
    }
    channel.postMessage(reply)
  }
  channel.addEventListener("message", listener)
  responder = {
    stop: () => {
      channel.removeEventListener("message", listener)
      channel.close()
      responder = null
    },
  }
}

/** Record a turn this document has just opened and is now driving. */
export function rememberOpenBundleTurn(turn: OpenBundleTurn): void {
  live.add(turn.bundleTurnId)
  ensureResponder()
  const records = readRecords().filter((entry) => entry.bundleTurnId !== turn.bundleTurnId)
  records.push(turn)
  writeRecords(records)
}

/**
 * Forget a turn that has settled.
 *
 * Called on both the settle and the abort edge. A record left behind is not a
 * correctness problem (the poll would find no claimant, and aborting a turn the
 * host has already settled is a no-op), but it would make every later reclaim
 * do pointless work.
 */
export function forgetOpenBundleTurn(bundleTurnId: string): void {
  live.delete(bundleTurnId)
  const records = readRecords().filter((entry) => entry.bundleTurnId !== bundleTurnId)
  writeRecords(records)
  if (live.size === 0) responder?.stop()
}

/** Which turns this document is still driving. Exported for the poll's tests. */
export function liveBundleTurnIds(): string[] {
  return [...live]
}

/**
 * Ask every tab of this browser which of the recorded turns it still drives.
 *
 * Returns the ids nobody claimed. With no channel available (an older engine, a
 * document with the API blocked) this answers with nothing rather than with
 * everything: unable to ask is not the same as nobody answered, and treating it
 * as the latter would abort a turn that is running perfectly.
 */
async function pollForClaims(candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return []
  const channel = deps.openChannel()
  if (!channel) return []
  const nonce = `${deps.now()}:${Math.random().toString(36).slice(2)}`
  const claimed = new Set<string>(candidates.filter((id) => live.has(id)))
  const listener = (event: { data: unknown }) => {
    const message = event.data as ClaimMessage | undefined
    if (message?.kind !== "cognia.bundle-turn.claim" || message.nonce !== nonce) return
    for (const id of message.bundleTurnIds) claimed.add(id)
  }
  channel.addEventListener("message", listener)
  try {
    const poll: PollMessage = {
      kind: "cognia.bundle-turn.poll",
      nonce,
      bundleTurnIds: candidates,
    }
    channel.postMessage(poll)
    await deps.waitForClaims(PEER_REPLY_WINDOW_MS)
  } finally {
    channel.removeEventListener("message", listener)
    channel.close()
  }
  return candidates.filter((id) => !claimed.has(id))
}

/**
 * End this browser's abandoned turns for one conversation.
 *
 * Returns the ids it released, so a caller can decide whether retrying is worth
 * it: an empty answer means the blocking turn belongs to something still alive
 * (another tab, another device) and the refusal was correct.
 */
export async function reclaimAbandonedBundleTurns(sessionId: string): Promise<string[]> {
  const candidates = readRecords()
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.bundleTurnId)
  const abandoned = await pollForClaims(candidates)
  const released: string[] = []
  for (const bundleTurnId of abandoned) {
    try {
      await deps.abort(bundleTurnId)
      released.push(bundleTurnId)
    } catch {
      // A turn the host has already settled, or one it will not let this device
      // touch. Either way it is not this client's to release, and the caller's
      // retry will be refused again with the host's own reason rather than with
      // one invented here.
    }
    forgetOpenBundleTurn(bundleTurnId)
  }
  return released
}
