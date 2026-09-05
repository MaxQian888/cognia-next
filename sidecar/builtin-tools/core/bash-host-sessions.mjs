// Host-backed background-shell registry.
//
// Implements the SAME port interface as `bash-sessions.mjs`'s in-process
// registry (`spawnBackground` / `read` / `waitForOutput` / `kill` / `killAll` /
// `list`), so `bash.mjs` and the dispatch modules are unchanged — only the
// adapter behind the port swaps. What changes is where the processes actually
// live: the Rust supervisor (`crates/cognia-jobs`) instead of this Node
// process.
//
// That relocation is what buys:
//   * process-group kill, so `sh -c "pnpm dev"` grandchildren die too,
//   * survival across a sidecar restart and a webview reload,
//   * visibility from the Job Center, a remote client, and a headless host,
//   * output history on disk rather than a 256 KB in-memory window.
//
// Offsets, not a consume-once cursor. The host serves byte ranges and reads are
// non-destructive, so this adapter can keep a convenience cursor per shell
// (preserving the "give me what's new" ergonomics) while still being able to
// re-read a range. That is what makes `filter` mean "wait until this matches"
// instead of "eat everything, then show what matched".

import { createBgShellRegistry } from "./bash-sessions.mjs"

import { HOST_RPC_TIMEOUT_MARGIN_MS } from "../../host-rpc.mjs"

/** Cap on bytes pulled per host round-trip. */
const READ_CHUNK_BYTES = 30_000

/** Longest a single long-poll may block, mirroring the tool schema's cap. */
export const MAX_WAIT_MS = 30_000

/**
 * Keep only lines matching `filter`. An invalid regex degrades to "no filter"
 * rather than failing the read — same tolerance the previous implementation had.
 */
export function applyLineFilter(text, filter) {
  if (!filter || !text) return text
  let re
  try {
    re = new RegExp(filter)
  } catch {
    return text
  }
  return text
    .split("\n")
    .filter((line) => re.test(line))
    .join("\n")
}

/**
 * @param {{
 *   hostRpc: { call: (m: string, p: any, o?: any) => Promise<any> },
 *   sessionId: string,
 * }} ctx
 */
export function createHostBgShellRegistry({ hostRpc, sessionId }) {
  /** shellId → next unread absolute byte offset. */
  const cursors = new Map()
  /** shellId → the command line, for `list` output before the host answers. */
  const known = new Set()

  const sessionOwner = { kind: "session", sessionId }
  /** `detach` promotes a job past the session that started it. */
  const ownerFor = (detach) => (detach ? { kind: "app" } : sessionOwner)

  async function spawnBackground({ command, shell, shellArgs, cwd, isWin, env, detach, label }) {
    const record = await hostRpc.call("jobs.spawn", {
      command,
      program: shell,
      args: shellArgs,
      cwd,
      env: env ? { ...env } : {},
      owner: ownerFor(detach),
      windowsVerbatimArguments: Boolean(isWin),
      label: label ?? null,
    })
    cursors.set(record.id, 0)
    known.add(record.id)
    return record
  }

  /** One non-blocking read from the caller's cursor (or an explicit offset). */
  async function read(id, { filter, maxChars, fromOffset } = {}) {
    const start = Number.isFinite(fromOffset) ? Number(fromOffset) : (cursors.get(id) ?? 0)
    let slice
    try {
      slice = await hostRpc.call("jobs.read", {
        jobId: id,
        fromOffset: start,
        maxBytes: clampChunk(maxChars),
      })
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) }
    }
    // Only advance the shared cursor for a cursor-relative read; an explicit
    // `fromOffset` is a look-back and must not disturb the caller's position.
    if (!Number.isFinite(fromOffset)) cursors.set(id, slice.nextOffset)
    return toResult(slice, filter)
  }

  /**
   * Long-poll until `filter` matches, the job exits, or the budget runs out.
   *
   * With no filter this returns on the first bytes, exactly like before. WITH a
   * filter it keeps waiting for a match instead of returning an empty result —
   * the old implementation advanced its cursor past non-matching bytes and lost
   * them, so a filtered wait could never actually wait for a pattern.
   */
  async function waitForOutput(id, { filter, maxChars, waitMs = 0 } = {}) {
    const budget = Math.min(Math.max(0, Math.floor(waitMs)), MAX_WAIT_MS)
    const deadline = Date.now() + budget
    const cap = clampChunk(maxChars)
    let cursor = cursors.get(id) ?? 0
    let accumulated = ""
    let last = null

    for (;;) {
      const remaining = Math.max(0, deadline - Date.now())
      let slice
      try {
        slice = await hostRpc.call(
          "jobs.wait",
          { jobId: id, fromOffset: cursor, maxBytes: cap, waitMs: remaining },
          // Outlast the host's own wait, or we would time out on a healthy poll.
          { timeoutMs: remaining + HOST_RPC_TIMEOUT_MARGIN_MS }
        )
      } catch (err) {
        return { ok: false, reason: String(err?.message ?? err) }
      }
      last = slice
      cursor = slice.nextOffset
      accumulated += slice.data
      cursors.set(id, cursor)

      const matched = applyLineFilter(accumulated, filter)
      const done =
        matched.length > 0 ||
        slice.status !== "running" ||
        Date.now() >= deadline ||
        // No filter and no new bytes with budget exhausted — nothing to wait for.
        (!filter && remaining === 0)
      if (done) {
        return {
          ok: true,
          data: matched,
          status: slice.status,
          exitCode: slice.exitCode ?? null,
          nextOffset: cursor,
          hasMore: Boolean(slice.hasMore),
        }
      }
    }
  }

  async function kill(id) {
    try {
      const record = await hostRpc.call("jobs.kill", {
        jobId: id,
        // Scoped: an agent may only kill what its own session owns. The host
        // rejects anything else, so one chat cannot reach another's jobs.
        requester: sessionOwner,
      })
      return { ok: true, exitCode: record.exitCode ?? null }
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) }
    }
  }

  /**
   * Kill a job addressed by OS pid, for `terminate_process`.
   *
   * `matched: false` distinguishes "that pid is not one of our jobs" from a
   * failure, so the caller can fall back to signalling the pid directly
   * instead of refusing to act on a process we simply do not own.
   */
  async function killByPid(pid) {
    try {
      const res = await hostRpc.call("jobs.killByPid", { pid, requester: sessionOwner })
      if (!res?.matched) return { matched: false }
      return { matched: true, ok: true, jobId: res.job?.id ?? null }
    } catch (err) {
      return { matched: true, ok: false, reason: String(err?.message ?? err) }
    }
  }

  /**
   * Session teardown. Only reaps SESSION-owned jobs — a `detach`ed job is
   * app-owned precisely so it survives this, and a scheduled task's job belongs
   * to the task, not to the chat turn that happened to start it.
   */
  async function killAll() {
    try {
      await hostRpc.call("jobs.killOwnedBy", { owner: sessionOwner })
    } catch {
      // Best-effort: the host also reaps session-owned jobs on its own grace
      // timer, and everything is killed at app exit regardless.
    }
    cursors.clear()
    known.clear()
  }

  async function list() {
    // Deliberately NOT catch-and-return-[]. An empty array is a factual claim
    // ("this session has no background shells") and swallowing an RPC failure
    // — a 30 s host timeout, a closed channel — made "we could not ask" look
    // identical to "there are none". `list_shells` surfaces the throw as a
    // tool error instead.
    const { jobs } = await hostRpc.call("jobs.list", { owner: sessionOwner })
    return (jobs ?? []).map(toListRow)
  }

  return { spawnBackground, read, waitForOutput, kill, killByPid, killAll, list }
}

function clampChunk(maxChars) {
  const n = Number.isFinite(maxChars) ? Math.floor(Number(maxChars)) : READ_CHUNK_BYTES
  return Math.min(Math.max(1, n), READ_CHUNK_BYTES)
}

function toResult(slice, filter) {
  return {
    ok: true,
    data: applyLineFilter(slice.data, filter),
    status: slice.status,
    exitCode: slice.exitCode ?? null,
    nextOffset: slice.nextOffset,
    hasMore: Boolean(slice.hasMore),
  }
}

/** Shape a host record like the old `list()` rows so callers are unchanged. */
function toListRow(job) {
  const endedAt = job.endedAtMs ?? null
  return {
    id: job.id,
    command: job.command,
    status: job.status === "running" ? "running" : "exited",
    exitCode: job.exitCode ?? null,
    startedAt: job.startedAtMs,
    endedAt,
    durationMs: Math.max(0, (endedAt ?? Date.now()) - job.startedAtMs),
    cwd: job.cwd,
    // New, and only available now that jobs outlive their session.
    owner: job.owner,
    terminalStatus: job.status,
    droppedOutputBytes: job.droppedOutputBytes ?? 0,
  }
}

/** Choose an implemented host port; an RPC transport alone is not jobs readiness. */
export function createSessionBgShellRegistry({ hostRpc, sessionId, backgroundProcessHost }) {
  return hostRpc && backgroundProcessHost !== "sidecar"
    ? createHostBgShellRegistry({ hostRpc, sessionId })
    : createBgShellRegistry()
}
