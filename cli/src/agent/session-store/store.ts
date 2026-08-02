/**
 * The canonical session store facade.
 *
 * Owns the lifecycle every caller (CLI, SDK, RPC) shares: create / open /
 * continue / fork / clone / list / tree, the single-writer lease around all of
 * them, and the honest resume report that says how faithfully history came
 * back and what was lost getting it.
 *
 * Design rules that are load-bearing, not stylistic:
 *
 * - **Immutable forks.** `fork` and `clone` COPY a prefix of the parent's log
 *   into a new session. The parent is never rewritten, so a fork can never
 *   corrupt the history it branched from, and `tree` can always reconstruct
 *   the real lineage.
 * - **No replayed grants.** Materialized permission events come back as
 *   `pending`/`deny` only. A historical `allow` is evidence that a human once
 *   approved something in a context that no longer exists; re-honoring it
 *   would let a resumed session act with authority nobody granted it now.
 * - **Structured conflicts, not exceptions.** Contention returns
 *   `session_locked`; a missing session returns `session_not_found`. Callers
 *   branch on codes and map them to exit codes — they never string-match.
 */

import os from "node:os"

import type {
  AgentResumeReport,
  AgentRunUsage,
  AgentStructuredError,
} from "@cognia/agent-config-types/agent-run-result"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type {
  CanonicalPermissionEvent,
  CanonicalSession,
  CanonicalTurn,
} from "@cognia/agent-config-types/canonical-session"
import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"

import { importLegacyTranscript } from "./legacy"
import {
  acquireLease,
  defaultIsProcessAlive,
  isLeaseStale,
  readLease,
  releaseLease,
  startLeaseHeartbeat,
  LEASE_STALE_AFTER_MS,
  type LeaseEnvironment,
  type SessionLease,
} from "./lease"
import { appendEnvelopes, materializeSession, readEventLog, type MaterializedSession } from "./log"
import {
  createManifest,
  mergeUsage,
  parseManifest,
  serializeManifest,
  type SessionForkKind,
  type SessionLineage,
  type SessionManifest,
  type SessionRuntimeBinding,
} from "./manifest"
import {
  eventLogPath,
  isSafeSessionId,
  manifestPath,
  realSessionStoreFs,
  sessionDir,
  sessionsRoot,
  workspaceKey,
  type SessionStoreFs,
} from "./paths"

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: AgentStructuredError }

export interface SessionStoreOptions {
  home: string
  /** `--session-dir`: relocate the whole store (tests, sandboxes, CI). */
  sessionDirOverride?: string
  fsx?: SessionStoreFs
  now?: () => number
  host?: string
  pid?: number
  mintToken?: () => string
  isProcessAlive?: (pid: number) => boolean
  staleAfterMs?: number
  /** Heartbeat cadence; 0 disables the timer (tests drive renew manually). */
  heartbeatMs?: number
}

export interface SessionSummary {
  sessionId: string
  name?: string
  workspace: string
  createdAt: string
  updatedAt: string
  turnCount: number
  lineage?: SessionLineage
  backend?: string
  model?: string
  /** True when another process currently holds the writable lease. */
  locked: boolean
  lastAssistantText?: string
}

export interface OpenSessionOptions {
  /** Acquire the writable lease. Read-only opens (list/export/tree) skip it. */
  writable?: boolean
  /** Workspace the caller is running in; recorded on create. */
  cwd?: string
  name?: string
  runtimeBinding?: SessionRuntimeBinding
  /**
   * Allow opening a session recorded against a DIFFERENT workspace. `--continue`
   * never sets this (it selects by workspace); an explicit `--session` may,
   * after resource trust has been re-evaluated for the new root.
   */
  allowForeignWorkspace?: boolean
}

/** A live, writable (or read-only) handle on one canonical session. */
export interface SessionHandle {
  readonly sessionId: string
  readonly dir: string
  readonly manifest: SessionManifest
  readonly writable: boolean
  /** History as canonical turns, materialized from the log. */
  readonly turns: CanonicalTurn[]
  /** Approval history, with historical allows downgraded (see module docs). */
  readonly permissions: CanonicalPermissionEvent[]
  /** Present when this open restored prior history. */
  readonly resume: AgentResumeReport | null
  /** Append envelopes to the append-only log. No-op on a read-only handle. */
  append(envelopes: readonly AgentEventEnvelope[]): void
  /** Fold a completed turn's derived state into the manifest and persist it. */
  commitTurn(update: {
    turnsAdded?: number
    usage?: AgentRunUsage
    lastAssistantText?: string
    runtimeBinding?: SessionRuntimeBinding
    executionFingerprint?: string
    contextVersion?: string
  }): void
  setName(name: string): void
  /** Release the lease and stop the heartbeat. Idempotent. */
  close(): void
}

export interface SessionTreeNode {
  sessionId: string
  name?: string
  createdAt: string
  turnCount: number
  forkKind?: SessionForkKind
  parentTurnId?: string
  children: SessionTreeNode[]
}

function fail(
  code: AgentStructuredError["code"],
  message: string,
  detail?: Record<string, unknown>
): { ok: false; error: AgentStructuredError } {
  return { ok: false, error: { code, message, ...(detail ? { detail } : {}) } }
}

/**
 * Downgrade historical approvals. `allow`/`allow_always` become `pending`:
 * the decision is preserved as "this was asked about" without carrying the
 * grant forward. `deny` survives verbatim — re-denying is always safe.
 */
export function withoutReplayedGrants(
  permissions: readonly CanonicalPermissionEvent[]
): CanonicalPermissionEvent[] {
  return permissions.map((permission) =>
    permission.decision === "allow" || permission.decision === "allow_always"
      ? { ...permission, decision: "pending" as const }
      : { ...permission }
  )
}

export function createSessionStore(options: SessionStoreOptions) {
  const fsx = options.fsx ?? realSessionStoreFs
  const now = options.now ?? Date.now
  const override = options.sessionDirOverride
  const root = sessionsRoot(options.home, override)
  const heartbeatMs = options.heartbeatMs ?? undefined

  const leaseEnv: LeaseEnvironment = {
    fsx,
    home: options.home,
    ...(override ? { sessionDirOverride: override } : {}),
    now,
    ...(options.host ? { host: options.host } : {}),
    ...(options.pid !== undefined ? { pid: options.pid } : {}),
    ...(options.mintToken ? { mintToken: options.mintToken } : {}),
    ...(options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {}),
    ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
  }

  function readManifest(sessionId: string): SessionManifest | null {
    return parseManifest(fsx.readFile(manifestPath(options.home, sessionId, override)))
  }

  function writeManifest(manifest: SessionManifest): void {
    fsx.writeFileAtomic(
      manifestPath(options.home, manifest.sessionId, override),
      serializeManifest(manifest)
    )
  }

  function hasCanonicalStore(sessionId: string): boolean {
    return fsx.exists(manifestPath(options.home, sessionId, override))
  }

  /**
   * Is a session held by a LIVE writer? A stale lease left behind by a crashed
   * run must not make the session look busy — `--continue` would then skip the
   * very session the user just lost, and `list` would mislabel it forever.
   */
  function isLockedByLiveWriter(sessionId: string): boolean {
    const held = readLease(sessionId, leaseEnv)
    if (!held) return false
    return !isLeaseStale(held, {
      now: now(),
      host: options.host ?? os.hostname(),
      isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
      staleAfterMs: options.staleAfterMs ?? LEASE_STALE_AFTER_MS,
    })
  }

  /** Every session id with a canonical store, in directory order. */
  function listIds(): string[] {
    return fsx
      .readdir(root)
      .filter((entry) => isSafeSessionId(entry) && !entry.endsWith(".jsonl"))
      .filter((entry) => fsx.isDirectory(sessionDir(options.home, entry, override)))
      .filter((entry) => hasCanonicalStore(entry))
  }

  function materialize(sessionId: string): {
    materialized: MaterializedSession
    invalidLines: number
    truncatedTail: boolean
  } {
    const log = readEventLog(options.home, sessionId, fsx, override)
    return {
      materialized: materializeSession(log.envelopes),
      invalidLines: log.invalidLines + log.unparsableLines,
      truncatedTail: log.truncatedTail,
    }
  }

  function buildHandle(
    manifest: SessionManifest,
    lease: SessionLease | null,
    resume: AgentResumeReport | null,
    materialized: MaterializedSession
  ): SessionHandle {
    let current = manifest
    let closed = false
    const stopHeartbeat =
      lease && heartbeatMs !== 0
        ? startLeaseHeartbeat(lease, leaseEnv, undefined, heartbeatMs)
        : null

    return {
      sessionId: current.sessionId,
      dir: sessionDir(options.home, current.sessionId, override),
      get manifest() {
        return current
      },
      writable: lease !== null,
      turns: materialized.turns,
      permissions: withoutReplayedGrants(materialized.permissions),
      resume,
      append(envelopes) {
        if (!lease || closed || envelopes.length === 0) return
        appendEnvelopes(options.home, current.sessionId, envelopes, fsx, override)
        current = { ...current, eventCount: current.eventCount + envelopes.length }
      },
      commitTurn(update) {
        if (!lease || closed) return
        const turnCount = current.turnCount + (update.turnsAdded ?? 0)
        current = {
          ...current,
          turnCount,
          updatedAt: new Date(now()).toISOString(),
          ...(update.usage ? { usage: mergeUsage(current.usage, update.usage) } : {}),
          ...(update.lastAssistantText !== undefined
            ? { lastAssistantText: update.lastAssistantText }
            : {}),
          ...(update.runtimeBinding ? { runtimeBinding: update.runtimeBinding } : {}),
          ...(update.executionFingerprint
            ? { executionFingerprint: update.executionFingerprint }
            : {}),
          ...(update.contextVersion ? { contextVersion: update.contextVersion } : {}),
        }
        // The digest must describe what is ON DISK, so re-derive it from the
        // log rather than from the in-memory turns this handle opened with.
        current.sequenceDigest = computeSequenceDigest(
          materialize(current.sessionId).materialized.turns
        )
        writeManifest(current)
      },
      setName(name) {
        if (!lease || closed) return
        current = { ...current, name, updatedAt: new Date(now()).toISOString() }
        writeManifest(current)
      },
      close() {
        if (closed) return
        closed = true
        stopHeartbeat?.()
        if (lease) releaseLease(lease, leaseEnv)
      },
    }
  }

  function takeLease(sessionId: string): StoreResult<SessionLease> {
    const acquisition = acquireLease(sessionId, leaseEnv)
    if (acquisition.ok) return { ok: true, value: acquisition.lease }
    const holder = acquisition.heldBy
    return fail(
      "session_locked",
      holder
        ? `session ${sessionId} is open for writing by pid ${holder.pid} on ${holder.host}`
        : `session ${sessionId} is open for writing by another process`,
      holder ? { pid: holder.pid, host: holder.host, since: holder.startedAt } : undefined
    )
  }

  return {
    /** Create a brand-new canonical session. Fails if one already exists. */
    create(sessionId: string, opts: OpenSessionOptions = {}): StoreResult<SessionHandle> {
      if (!isSafeSessionId(sessionId)) {
        return fail("usage_error", `invalid session id "${sessionId}"`)
      }
      if (hasCanonicalStore(sessionId)) {
        return fail("usage_error", `session ${sessionId} already exists`)
      }
      const lease = takeLease(sessionId)
      if (!lease.ok) return lease
      const at = new Date(now()).toISOString()
      const manifest = createManifest({
        sessionId,
        workspace: workspaceKey(opts.cwd ?? process.cwd()),
        at,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.runtimeBinding ? { runtimeBinding: opts.runtimeBinding } : {}),
        sequenceDigest: computeSequenceDigest([]),
      })
      writeManifest(manifest)
      return {
        ok: true,
        value: buildHandle(manifest, lease.value, null, {
          turns: [],
          permissions: [],
          checkpoints: [],
          lastAssistantText: "",
        }),
      }
    },

    /**
     * Open an existing session. When no canonical store exists but a legacy
     * flat transcript does, the store is CREATED from it — atomically, and
     * without touching the legacy file.
     */
    open(sessionId: string, opts: OpenSessionOptions = {}): StoreResult<SessionHandle> {
      if (!isSafeSessionId(sessionId)) {
        return fail("usage_error", `invalid session id "${sessionId}"`)
      }
      const writable = opts.writable !== false
      let manifest = readManifest(sessionId)
      let resume: AgentResumeReport | null = null
      let lease: SessionLease | null = null

      if (writable) {
        const taken = takeLease(sessionId)
        if (!taken.ok) return taken
        lease = taken.value
      }

      const releaseOnFailure = <T>(result: { ok: false; error: AgentStructuredError }): T => {
        if (lease) releaseLease(lease, leaseEnv)
        return result as unknown as T
      }

      if (!manifest) {
        const legacy = importLegacyTranscript(options.home, sessionId, fsx, override)
        if (!legacy.found) {
          return releaseOnFailure(fail("session_not_found", `no session ${sessionId}`))
        }
        if (!writable) {
          // A read-only open of a not-yet-migrated session materializes in
          // memory rather than writing — a `list`/`export` must never mutate.
          const at = new Date(now()).toISOString()
          manifest = createManifest({
            sessionId,
            workspace: workspaceKey(opts.cwd ?? process.cwd()),
            at,
            sequenceDigest: computeSequenceDigest(legacy.turns),
            turnCount: legacy.turns.length,
            eventCount: legacy.envelopes.length,
          })
          return {
            ok: true,
            value: buildHandle(
              manifest,
              null,
              {
                native: false,
                fidelity: legacy.loss.fidelity,
                loss: legacy.loss,
                invalidLegacyLines: legacy.invalidLines,
              },
              materializeSession(legacy.envelopes)
            ),
          }
        }
        // First canonical write: seed the log, then publish the manifest. The
        // manifest is written LAST so a crash mid-seed leaves no store at all
        // (the legacy file is still authoritative) rather than an empty one.
        const at = new Date(now()).toISOString()
        appendEnvelopes(options.home, sessionId, legacy.envelopes, fsx, override)
        manifest = createManifest({
          sessionId,
          workspace: workspaceKey(opts.cwd ?? process.cwd()),
          at,
          sequenceDigest: computeSequenceDigest(legacy.turns),
          turnCount: legacy.turns.length,
          eventCount: legacy.envelopes.length,
          legacy: {
            sourcePath: legacy.sourcePath,
            invalidLines: legacy.invalidLines,
            fidelity: legacy.loss.fidelity,
            importedAt: at,
          },
          ...(legacy.nativeSessionId || legacy.model
            ? {
                runtimeBinding: {
                  backend: opts.runtimeBinding?.backend ?? "builtin",
                  ...(legacy.nativeSessionId ? { nativeSessionId: legacy.nativeSessionId } : {}),
                  ...(legacy.model ? { model: legacy.model } : {}),
                  ...(legacy.provider ? { provider: legacy.provider } : {}),
                },
              }
            : {}),
        })
        writeManifest(manifest)
        resume = {
          native: false,
          fidelity: legacy.loss.fidelity,
          loss: legacy.loss,
          invalidLegacyLines: legacy.invalidLines,
        }
      }

      if (
        !opts.allowForeignWorkspace &&
        opts.cwd !== undefined &&
        manifest.workspace !== workspaceKey(opts.cwd)
      ) {
        return releaseOnFailure(
          fail(
            "resource_untrusted",
            `session ${sessionId} belongs to workspace ${manifest.workspace}; re-evaluate resource trust before opening it from ${workspaceKey(opts.cwd)}`,
            { sessionWorkspace: manifest.workspace, requestedWorkspace: workspaceKey(opts.cwd) }
          )
        )
      }

      const { materialized, invalidLines, truncatedTail } = materialize(sessionId)
      if (!resume) {
        // A native binding is only usable when the runtime still knows the
        // session; the runtime decides that, so the store reports what it HAS
        // and lets the runtime downgrade to contextual replay if it must.
        const hasNativeBinding = Boolean(manifest.runtimeBinding?.nativeSessionId)
        const losses = [
          ...(invalidLines > 0
            ? [
                {
                  path: "events",
                  kind: "dropped" as const,
                  detail: `${invalidLines} unreadable log line(s)`,
                },
              ]
            : []),
          ...(truncatedTail
            ? [
                {
                  path: "events.tail",
                  kind: "dropped" as const,
                  detail: "the log ends mid-line — the last write was interrupted",
                },
              ]
            : []),
        ]
        resume = {
          native: hasNativeBinding,
          fidelity: hasNativeBinding ? "native-exact" : "contextual",
          loss: {
            fidelity: hasNativeBinding ? "native-exact" : "contextual",
            losses,
          },
          ...(manifest.legacy ? { invalidLegacyLines: manifest.legacy.invalidLines } : {}),
        }
      }

      return { ok: true, value: buildHandle(manifest, lease, resume, materialized) }
    },

    /**
     * Newest compatible, UNLOCKED session for `cwd` — what `--continue` picks.
     * Locked sessions are skipped rather than reported: continuing means "the
     * one I was just using", and the one another process is using is not it.
     */
    findLatestForWorkspace(cwd: string): string | null {
      const key = workspaceKey(cwd)
      let best: { id: string; updatedAt: string } | null = null
      for (const id of listIds()) {
        const manifest = readManifest(id)
        if (!manifest || manifest.workspace !== key) continue
        if (isLockedByLiveWriter(id)) continue
        if (!best || manifest.updatedAt > best.updatedAt) {
          best = { id, updatedAt: manifest.updatedAt }
        }
      }
      return best?.id ?? null
    },

    list(): SessionSummary[] {
      const summaries: SessionSummary[] = []
      for (const id of listIds()) {
        const manifest = readManifest(id)
        if (!manifest) continue
        summaries.push({
          sessionId: id,
          ...(manifest.name ? { name: manifest.name } : {}),
          workspace: manifest.workspace,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
          turnCount: manifest.turnCount,
          ...(manifest.lineage ? { lineage: manifest.lineage } : {}),
          ...(manifest.runtimeBinding?.backend ? { backend: manifest.runtimeBinding.backend } : {}),
          ...(manifest.runtimeBinding?.model ? { model: manifest.runtimeBinding.model } : {}),
          locked: isLockedByLiveWriter(id),
          ...(manifest.lastAssistantText ? { lastAssistantText: manifest.lastAssistantText } : {}),
        })
      }
      return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    },

    /**
     * Branch a new session off `sourceId`.
     *
     * `kind: "fork"` with a `turnId` copies the log PREFIX up to and including
     * that turn; `kind: "clone"` copies the whole log. Either way the source is
     * opened read-only and never modified.
     */
    branch(
      sourceId: string,
      newId: string,
      kind: SessionForkKind,
      turnId?: string,
      opts: OpenSessionOptions = {}
    ): StoreResult<SessionHandle> {
      if (!isSafeSessionId(newId)) return fail("usage_error", `invalid session id "${newId}"`)
      if (hasCanonicalStore(newId)) return fail("usage_error", `session ${newId} already exists`)
      const sourceManifest = readManifest(sourceId)
      if (!sourceManifest) return fail("session_not_found", `no session ${sourceId}`)

      const log = readEventLog(options.home, sourceId, fsx, override)
      let prefix = log.envelopes
      if (kind === "fork" && turnId) {
        const cut = prefix.findIndex((envelope) => envelope.turnId === turnId)
        if (cut === -1) {
          return fail("usage_error", `turn ${turnId} is not in session ${sourceId}`)
        }
        // Inclusive of the whole named turn: keep every envelope up to the
        // first one belonging to a LATER turn.
        let end = cut
        while (end < prefix.length && prefix[end]?.turnId === turnId) end += 1
        prefix = prefix.slice(0, end)
      }

      const lease = takeLease(newId)
      if (!lease.ok) return lease
      const materialized = materializeSession(prefix)
      const at = new Date(now()).toISOString()
      appendEnvelopes(options.home, newId, prefix, fsx, override)
      const lineage: SessionLineage = {
        parentSessionId: sourceId,
        ...(kind === "fork" && turnId ? { parentTurnId: turnId } : {}),
        kind,
      }
      const manifest = createManifest({
        sessionId: newId,
        workspace: opts.cwd ? workspaceKey(opts.cwd) : sourceManifest.workspace,
        at,
        ...(opts.name ? { name: opts.name } : {}),
        lineage,
        // The native binding is NOT inherited: two sessions cannot share one
        // runtime-side conversation, and pointing a fork at the parent's
        // handle would have the runtime append the fork's turns to the parent.
        ...(sourceManifest.runtimeBinding
          ? {
              runtimeBinding: {
                backend: sourceManifest.runtimeBinding.backend,
                ...(sourceManifest.runtimeBinding.model
                  ? { model: sourceManifest.runtimeBinding.model }
                  : {}),
                ...(sourceManifest.runtimeBinding.provider
                  ? { provider: sourceManifest.runtimeBinding.provider }
                  : {}),
              },
            }
          : {}),
        sequenceDigest: computeSequenceDigest(materialized.turns),
        turnCount: materialized.turns.length,
        eventCount: prefix.length,
      })
      writeManifest(manifest)
      return {
        ok: true,
        value: buildHandle(
          manifest,
          lease.value,
          {
            native: false,
            fidelity: "structured",
            loss: {
              fidelity: "structured",
              losses: [
                {
                  path: "runtimeBinding.nativeSessionId",
                  kind: "dropped",
                  detail: "a branch starts a fresh runtime conversation",
                },
              ],
            },
          },
          materialized
        ),
      }
    },

    /** Cross-session lineage graph. Orphaned parents surface as roots. */
    tree(): SessionTreeNode[] {
      const manifests = new Map<string, SessionManifest>()
      for (const id of listIds()) {
        const manifest = readManifest(id)
        if (manifest) manifests.set(id, manifest)
      }
      const nodes = new Map<string, SessionTreeNode>()
      for (const [id, manifest] of manifests) {
        nodes.set(id, {
          sessionId: id,
          ...(manifest.name ? { name: manifest.name } : {}),
          createdAt: manifest.createdAt,
          turnCount: manifest.turnCount,
          ...(manifest.lineage ? { forkKind: manifest.lineage.kind } : {}),
          ...(manifest.lineage?.parentTurnId
            ? { parentTurnId: manifest.lineage.parentTurnId }
            : {}),
          children: [],
        })
      }
      const roots: SessionTreeNode[] = []
      for (const [id, manifest] of manifests) {
        const node = nodes.get(id)
        if (!node) continue
        const parentId = manifest.lineage?.parentSessionId
        const parent = parentId ? nodes.get(parentId) : undefined
        if (parent) parent.children.push(node)
        else roots.push(node)
      }
      const sortByCreated = (list: SessionTreeNode[]): void => {
        list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        for (const child of list) sortByCreated(child.children)
      }
      sortByCreated(roots)
      return roots
    },

    /** Project a session as a `CanonicalSession` for export / import round-trip. */
    toCanonicalSession(sessionId: string): StoreResult<CanonicalSession> {
      const manifest = readManifest(sessionId)
      if (!manifest) return fail("session_not_found", `no session ${sessionId}`)
      const { materialized } = materialize(sessionId)
      return {
        ok: true,
        value: {
          header: {
            canonicalVersion: 1,
            canonicalSessionId: sessionId,
            sourceRuntime: manifest.runtimeBinding?.backend ?? "cognia",
            ...(manifest.runtimeBinding?.nativeSessionId
              ? {
                  runtimeBinding: { nativeSessionId: manifest.runtimeBinding.nativeSessionId },
                }
              : {}),
            ...(manifest.name ? { title: manifest.name } : {}),
            createdAt: manifest.createdAt,
            updatedAt: manifest.updatedAt,
            turnCount: materialized.turns.length,
            importFidelity: manifest.legacy?.fidelity ?? "structured",
            sequenceDigest: computeSequenceDigest(materialized.turns),
          },
          turns: materialized.turns,
          permissions: withoutReplayedGrants(materialized.permissions),
          checkpoints: materialized.checkpoints,
        },
      }
    },

    /** Raw envelope log — what `session.getEntries` and JSONL export return. */
    readEnvelopes(sessionId: string): AgentEventEnvelope[] {
      return readEventLog(options.home, sessionId, fsx, override).envelopes
    },

    /** Absolute paths, for the run result's persistence block. */
    paths(sessionId: string) {
      return {
        dir: sessionDir(options.home, sessionId, override),
        manifest: manifestPath(options.home, sessionId, override),
        events: eventLogPath(options.home, sessionId, override),
      }
    },

    host: options.host ?? os.hostname(),
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
