import path from "node:path"

import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"

import { legacyTranscriptPath, manifestPath, eventLogPath } from "./paths"
import { createSessionStore, withoutReplayedGrants, type SessionStoreOptions } from "./store"
import { createMemoryFs, type MemoryFs } from "./test-fs"

const HOME = path.join(path.sep, "home", "u", ".cognia")
const REPO = path.join(path.sep, "repo")
const OTHER_REPO = path.join(path.sep, "other")

let sequence = 0
function envelope(event: CanonicalAgentEvent, turnId = "t1", sessionId = "s1"): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `${sessionId}:a1:${sequence}`,
    sequence: sequence++,
    sessionId,
    runId: "r1",
    turnId,
    attemptId: "a1",
    hostRef: "headless-agent-host",
    runtime: "claude-agent-sdk",
    timestamp: "2026-01-01T00:00:00.000Z",
    event,
  }
}

function makeStore(fsx: MemoryFs, overrides: Partial<SessionStoreOptions> = {}) {
  let clock = 1_000_000
  return {
    store: createSessionStore({
      home: HOME,
      fsx,
      now: () => (clock += 1_000),
      host: "host-a",
      pid: 100,
      isProcessAlive: () => true,
      heartbeatMs: 0,
      ...overrides,
    }),
    advance: (ms: number) => (clock += ms),
  }
}

beforeEach(() => {
  sequence = 0
})

describe("create", () => {
  it("writes a manifest, takes the lease and starts empty", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO, name: "first" })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(created.value.sessionId).toBe("s1")
    expect(created.value.writable).toBe(true)
    expect(created.value.turns).toEqual([])
    expect(created.value.manifest).toMatchObject({
      manifestVersion: 1,
      workspace: REPO,
      name: "first",
      turnCount: 0,
    })
    expect(fsx.files.has(manifestPath(HOME, "s1"))).toBe(true)
  })

  it("rejects an unsafe id and an id that already exists", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const bad = store.create("../escape", { cwd: REPO })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe("usage_error")

    const first = store.create("s1", { cwd: REPO })
    if (first.ok) first.value.close()
    const again = store.create("s1", { cwd: REPO })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe("usage_error")
  })

  it("reports session_locked when a lease exists but no session was ever published", () => {
    // A crash between `acquireLease` and the manifest write leaves exactly this
    // state. The retry must report the CONFLICT, not "already exists" — there is
    // no session to have existed yet.
    const fsx = createMemoryFs()
    const first = makeStore(fsx).store
    const holder = first.create("s1", { cwd: REPO })
    if (!holder.ok) throw new Error("expected session")
    fsx.files.delete(manifestPath(HOME, "s1"))

    const second = makeStore(fsx, { pid: 200 }).store.create("s1", { cwd: REPO })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.code).toBe("session_locked")
      expect(second.error.detail).toMatchObject({ pid: 100, host: "host-a" })
    }
  })
})

describe("append / commitTurn", () => {
  it("appends to the log and folds derived state into the manifest", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")

    created.value.append([
      envelope({ kind: "user-input", text: "hi" }),
      envelope({ kind: "text-delta", delta: "hello" }),
    ])
    created.value.commitTurn({
      turnsAdded: 2,
      usage: { inputTokens: 10, outputTokens: 4 },
      lastAssistantText: "hello",
      runtimeBinding: { backend: "builtin", nativeSessionId: "sdk-1", model: "claude-opus-5" },
      executionFingerprint: "fp-1",
      contextVersion: "ctx-3",
    })

    const manifest = created.value.manifest
    expect(manifest).toMatchObject({
      turnCount: 2,
      usage: { inputTokens: 10, outputTokens: 4 },
      lastAssistantText: "hello",
      runtimeBinding: { nativeSessionId: "sdk-1" },
      executionFingerprint: "fp-1",
      contextVersion: "ctx-3",
      eventCount: 2,
    })
    expect(manifest.sequenceDigest).not.toBe("seq1-811c9dc5")
    created.value.close()
  })

  it("accumulates usage across turns rather than overwriting it", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.commitTurn({ turnsAdded: 1, usage: { inputTokens: 10 } })
    created.value.commitTurn({ turnsAdded: 1, usage: { inputTokens: 5, outputTokens: 2 } })
    expect(created.value.manifest.usage).toEqual({ inputTokens: 15, outputTokens: 2 })
  })

  it("ignores writes after close and on a read-only handle", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([envelope({ kind: "user-input", text: "hi" })])
    created.value.commitTurn({ turnsAdded: 1 })
    created.value.close()

    created.value.append([envelope({ kind: "user-input", text: "ignored" })])
    created.value.commitTurn({ turnsAdded: 5 })
    created.value.setName("ignored")
    expect(created.value.manifest.turnCount).toBe(1)

    const readOnly = store.open("s1", { cwd: REPO, writable: false })
    if (!readOnly.ok) throw new Error("expected session")
    readOnly.value.append([envelope({ kind: "user-input", text: "ignored" })])
    readOnly.value.setName("nope")
    expect(readOnly.value.manifest.name).toBeUndefined()
  })

  it("persists a rename", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.setName("renamed")
    created.value.close()
    const reopened = store.open("s1", { cwd: REPO, writable: false })
    expect(reopened.ok && reopened.value.manifest.name).toBe("renamed")
  })
})

describe("open", () => {
  it("restores turns from the log with a contextual resume report", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([
      envelope({ kind: "user-input", text: "hi" }),
      envelope({ kind: "text-delta", delta: "hello" }),
    ])
    created.value.commitTurn({ turnsAdded: 2 })
    created.value.close()

    const reopened = store.open("s1", { cwd: REPO })
    if (!reopened.ok) throw new Error("expected session")
    expect(reopened.value.turns.map((t) => t.text)).toEqual(["hi", "hello"])
    expect(reopened.value.resume).toMatchObject({ native: false, fidelity: "contextual" })
    reopened.value.close()
  })

  it("reports native-exact fidelity when a runtime binding survived", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.commitTurn({
      turnsAdded: 1,
      runtimeBinding: { backend: "builtin", nativeSessionId: "sdk-1" },
    })
    created.value.close()

    const reopened = store.open("s1", { cwd: REPO })
    expect(reopened.ok && reopened.value.resume).toMatchObject({
      native: true,
      fidelity: "native-exact",
    })
  })

  it("reports unreadable lines and a truncated tail in the resume loss report", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([envelope({ kind: "user-input", text: "hi" })])
    created.value.close()
    fsx.appendFile(eventLogPath(HOME, "s1"), "{ truncated line without newline")

    const reopened = store.open("s1", { cwd: REPO })
    if (!reopened.ok) throw new Error("expected session")
    const paths = reopened.value.resume?.loss.losses.map((l) => l.path) ?? []
    expect(paths).toEqual(expect.arrayContaining(["events", "events.tail"]))
  })

  it("reports session_not_found for an unknown id", () => {
    const result = makeStore(createMemoryFs()).store.open("ghost", { cwd: REPO })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("session_not_found")
  })

  it("rejects an unsafe id", () => {
    const result = makeStore(createMemoryFs()).store.open("..", { cwd: REPO })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("usage_error")
  })

  it("refuses a session from another workspace until trust is re-evaluated", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.close()

    const foreign = store.open("s1", { cwd: OTHER_REPO })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) {
      expect(foreign.error.code).toBe("resource_untrusted")
      expect(foreign.error.detail).toMatchObject({ sessionWorkspace: REPO })
    }

    const allowed = store.open("s1", { cwd: OTHER_REPO, allowForeignWorkspace: true })
    expect(allowed.ok).toBe(true)
    if (allowed.ok) allowed.value.close()
  })

  it("releases the lease when the open then fails, so the session is not stranded", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.close()

    const foreign = store.open("s1", { cwd: OTHER_REPO })
    expect(foreign.ok).toBe(false)

    const retry = store.open("s1", { cwd: REPO })
    expect(retry.ok).toBe(true)
    if (retry.ok) retry.value.close()
  })

  it("propagates session_locked from a live writer", () => {
    const fsx = createMemoryFs()
    const first = makeStore(fsx).store
    const created = first.create("s1", { cwd: REPO })
    expect(created.ok).toBe(true)

    const second = makeStore(fsx, { pid: 200 }).store.open("s1", { cwd: REPO })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe("session_locked")
  })

  it("allows a read-only open while another process holds the writable lease", () => {
    const fsx = createMemoryFs()
    const first = makeStore(fsx).store
    const created = first.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([envelope({ kind: "user-input", text: "hi" })])

    const reader = makeStore(fsx, { pid: 200 }).store.open("s1", { cwd: REPO, writable: false })
    expect(reader.ok).toBe(true)
    if (reader.ok) expect(reader.value.writable).toBe(false)
  })

  it("downgrades historical approvals so no past grant is replayed", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([
      envelope({ kind: "permission-request", requestId: "p1", toolName: "Bash" }),
      envelope({ kind: "permission-resolved", requestId: "p1", behavior: "allow" }),
      envelope({ kind: "permission-request", requestId: "p2", toolName: "Write" }),
      envelope({ kind: "permission-resolved", requestId: "p2", behavior: "deny" }),
    ])
    created.value.close()

    const reopened = store.open("s1", { cwd: REPO })
    if (!reopened.ok) throw new Error("expected session")
    expect(reopened.value.permissions).toEqual([
      expect.objectContaining({ requestId: "p1", decision: "pending" }),
      expect.objectContaining({ requestId: "p2", decision: "deny" }),
    ])
  })
})

describe("legacy migration on open", () => {
  const legacy =
    JSON.stringify({ ts: 1000, role: "user", content: "hi" }) +
    "\n{ not json\n" +
    JSON.stringify({
      ts: 2000,
      role: "assistant",
      content: "hello",
      meta: { sdkSessionId: "sdk-1", model: "claude-opus-5" },
    }) +
    "\n"

  it("creates the canonical store from the flat transcript without touching it", () => {
    const fsx = createMemoryFs({ [legacyTranscriptPath(HOME, "s1")]: legacy })
    const { store } = makeStore(fsx)
    const opened = store.open("s1", { cwd: REPO })
    if (!opened.ok) throw new Error("expected session")

    expect(opened.value.turns.map((t) => t.text)).toEqual(["hi", "hello"])
    expect(fsx.files.get(legacyTranscriptPath(HOME, "s1"))).toBe(legacy)
    expect(fsx.files.has(manifestPath(HOME, "s1"))).toBe(true)
    opened.value.close()
  })

  it("reports the corrupt legacy line rather than swallowing it", () => {
    const fsx = createMemoryFs({ [legacyTranscriptPath(HOME, "s1")]: legacy })
    const { store } = makeStore(fsx)
    const opened = store.open("s1", { cwd: REPO })
    if (!opened.ok) throw new Error("expected session")
    expect(opened.value.resume).toMatchObject({
      native: false,
      fidelity: "contextual",
      invalidLegacyLines: 1,
    })
    expect(opened.value.manifest.legacy).toMatchObject({ invalidLines: 1 })
  })

  it("recovers the native binding from the legacy metadata", () => {
    const fsx = createMemoryFs({ [legacyTranscriptPath(HOME, "s1")]: legacy })
    const { store } = makeStore(fsx)
    const opened = store.open("s1", { cwd: REPO })
    expect(opened.ok && opened.value.manifest.runtimeBinding).toMatchObject({
      backend: "builtin",
      nativeSessionId: "sdk-1",
      model: "claude-opus-5",
    })
  })

  it("materializes a read-only open in memory without writing a store", () => {
    const fsx = createMemoryFs({ [legacyTranscriptPath(HOME, "s1")]: legacy })
    const { store } = makeStore(fsx)
    const opened = store.open("s1", { cwd: REPO, writable: false })
    if (!opened.ok) throw new Error("expected session")
    expect(opened.value.turns.map((t) => t.text)).toEqual(["hi", "hello"])
    expect(fsx.files.has(manifestPath(HOME, "s1"))).toBe(false)
  })

  it("migrates only once — a second open reads the canonical store", () => {
    const fsx = createMemoryFs({ [legacyTranscriptPath(HOME, "s1")]: legacy })
    const { store } = makeStore(fsx)
    const first = store.open("s1", { cwd: REPO })
    if (!first.ok) throw new Error("expected session")
    const eventsAfterFirst = fsx.files.get(eventLogPath(HOME, "s1"))
    first.value.close()

    const second = store.open("s1", { cwd: REPO })
    if (!second.ok) throw new Error("expected session")
    expect(fsx.files.get(eventLogPath(HOME, "s1"))).toBe(eventsAfterFirst)
    expect(second.value.manifest.legacy).toBeDefined()
  })
})

describe("findLatestForWorkspace", () => {
  it("picks the most recently updated session for the workspace", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    for (const id of ["s1", "s2"]) {
      const created = store.create(id, { cwd: REPO })
      if (!created.ok) throw new Error("expected session")
      created.value.commitTurn({ turnsAdded: 1 })
      created.value.close()
    }
    expect(store.findLatestForWorkspace(REPO)).toBe("s2")
  })

  it("ignores sessions from other workspaces and returns null when there are none", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: OTHER_REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.close()
    expect(store.findLatestForWorkspace(REPO)).toBeNull()
  })

  it("skips a session held by a live writer", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const held = store.create("s1", { cwd: REPO })
    if (!held.ok) throw new Error("expected session")
    held.value.commitTurn({ turnsAdded: 1 })
    // held stays open (lease live)
    expect(store.findLatestForWorkspace(REPO)).toBeNull()
    held.value.close()
    expect(store.findLatestForWorkspace(REPO)).toBe("s1")
  })

  it("does not skip a session whose lease is stale", () => {
    const fsx = createMemoryFs()
    const owner = makeStore(fsx)
    const held = owner.store.create("s1", { cwd: REPO })
    if (!held.ok) throw new Error("expected session")
    held.value.commitTurn({ turnsAdded: 1 })

    // A fresh store whose clock has moved well past the staleness window.
    const later = createSessionStore({
      home: HOME,
      fsx,
      now: () => 9_999_999_999,
      host: "host-a",
      pid: 300,
      isProcessAlive: () => true,
      heartbeatMs: 0,
    })
    expect(later.findLatestForWorkspace(REPO)).toBe("s1")
  })
})

describe("list", () => {
  it("summarizes sessions newest-first with lock state and binding", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const s1 = store.create("s1", { cwd: REPO, name: "one" })
    if (!s1.ok) throw new Error("expected session")
    s1.value.commitTurn({
      turnsAdded: 2,
      lastAssistantText: "done",
      runtimeBinding: { backend: "codex", model: "gpt-5" },
    })
    s1.value.close()
    const s2 = store.create("s2", { cwd: REPO })
    if (!s2.ok) throw new Error("expected session")
    s2.value.commitTurn({ turnsAdded: 1 })

    const summaries = store.list()
    expect(summaries.map((s) => s.sessionId)).toEqual(["s2", "s1"])
    expect(summaries[1]).toMatchObject({
      sessionId: "s1",
      name: "one",
      workspace: REPO,
      turnCount: 2,
      backend: "codex",
      model: "gpt-5",
      locked: false,
      lastAssistantText: "done",
    })
    expect(summaries[0]?.locked).toBe(true)
    s2.value.close()
  })

  it("ignores directories with no manifest and legacy transcript files", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "old")]: JSON.stringify({ ts: 1, role: "user", content: "x" }),
      [path.join(HOME, "sessions", "junk", "readme.txt")]: "not a session",
    })
    expect(makeStore(fsx).store.list()).toEqual([])
  })
})

describe("branch (fork / clone)", () => {
  function seed(fsx: MemoryFs) {
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([
      envelope({ kind: "user-input", text: "one" }, "t1"),
      envelope({ kind: "text-delta", delta: "first" }, "t1"),
      envelope({ kind: "user-input", text: "two" }, "t2"),
      envelope({ kind: "text-delta", delta: "second" }, "t2"),
    ])
    created.value.commitTurn({
      turnsAdded: 4,
      runtimeBinding: { backend: "builtin", nativeSessionId: "sdk-1", model: "claude-opus-5" },
    })
    created.value.close()
    return store
  }

  it("forks a prefix up to and including the named turn", () => {
    const fsx = createMemoryFs()
    const store = seed(fsx)
    const forked = store.branch("s1", "s1-fork", "fork", "t1", { cwd: REPO })
    if (!forked.ok) throw new Error("expected fork")
    expect(forked.value.turns.map((t) => t.text)).toEqual(["one", "first"])
    expect(forked.value.manifest.lineage).toEqual({
      parentSessionId: "s1",
      parentTurnId: "t1",
      kind: "fork",
    })
    forked.value.close()
  })

  it("clones the whole log from the head", () => {
    const fsx = createMemoryFs()
    const store = seed(fsx)
    const cloned = store.branch("s1", "s1-clone", "clone", undefined, { cwd: REPO })
    if (!cloned.ok) throw new Error("expected clone")
    expect(cloned.value.turns.map((t) => t.text)).toEqual(["one", "first", "two", "second"])
    expect(cloned.value.manifest.lineage).toEqual({ parentSessionId: "s1", kind: "clone" })
    cloned.value.close()
  })

  it("leaves the parent's log and manifest byte-identical", () => {
    const fsx = createMemoryFs()
    const store = seed(fsx)
    const beforeLog = fsx.files.get(eventLogPath(HOME, "s1"))
    const beforeManifest = fsx.files.get(manifestPath(HOME, "s1"))
    const forked = store.branch("s1", "s1-fork", "fork", "t1", { cwd: REPO })
    if (forked.ok) forked.value.close()
    expect(fsx.files.get(eventLogPath(HOME, "s1"))).toBe(beforeLog)
    expect(fsx.files.get(manifestPath(HOME, "s1"))).toBe(beforeManifest)
  })

  it("never inherits the parent's native session handle", () => {
    const fsx = createMemoryFs()
    const store = seed(fsx)
    const forked = store.branch("s1", "s1-fork", "fork", "t1", { cwd: REPO })
    if (!forked.ok) throw new Error("expected fork")
    expect(forked.value.manifest.runtimeBinding).toEqual({
      backend: "builtin",
      model: "claude-opus-5",
    })
    expect(forked.value.resume).toMatchObject({ native: false, fidelity: "structured" })
    forked.value.close()
  })

  it("rejects an unknown source, an unknown turn, a taken id and an unsafe id", () => {
    const fsx = createMemoryFs()
    const store = seed(fsx)
    expect(store.branch("ghost", "x", "clone").ok).toBe(false)
    const missingTurn = store.branch("s1", "x", "fork", "t99")
    expect(missingTurn.ok).toBe(false)
    if (!missingTurn.ok) expect(missingTurn.error.code).toBe("usage_error")
    const unsafe = store.branch("s1", "../x", "clone")
    expect(unsafe.ok).toBe(false)
    const taken = store.branch("s1", "s1", "clone")
    expect(taken.ok).toBe(false)
  })

  it("inherits the parent workspace when the caller names none", () => {
    const fsx = createMemoryFs()
    const store = seed(fsx)
    const cloned = store.branch("s1", "s1-clone", "clone")
    expect(cloned.ok && cloned.value.manifest.workspace).toBe(REPO)
    if (cloned.ok) cloned.value.close()
  })
})

describe("tree", () => {
  it("projects lineage as a graph rooted at un-forked sessions", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const root = store.create("s1", { cwd: REPO })
    if (!root.ok) throw new Error("expected session")
    root.value.append([envelope({ kind: "user-input", text: "one" }, "t1")])
    root.value.commitTurn({ turnsAdded: 1 })
    root.value.close()

    const fork = store.branch("s1", "s2", "fork", "t1", { cwd: REPO })
    if (fork.ok) fork.value.close()
    const grandchild = store.branch("s2", "s3", "clone", undefined, { cwd: REPO })
    if (grandchild.ok) grandchild.value.close()

    const tree = store.tree()
    expect(tree).toHaveLength(1)
    expect(tree[0]?.sessionId).toBe("s1")
    expect(tree[0]?.children[0]?.sessionId).toBe("s2")
    expect(tree[0]?.children[0]?.forkKind).toBe("fork")
    expect(tree[0]?.children[0]?.parentTurnId).toBe("t1")
    expect(tree[0]?.children[0]?.children[0]?.sessionId).toBe("s3")
  })

  it("surfaces an orphaned child as a root when its parent is gone", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const root = store.create("s1", { cwd: REPO })
    if (!root.ok) throw new Error("expected session")
    root.value.append([envelope({ kind: "user-input", text: "one" }, "t1")])
    root.value.commitTurn({ turnsAdded: 1 })
    root.value.close()
    const fork = store.branch("s1", "s2", "fork", "t1", { cwd: REPO })
    if (fork.ok) fork.value.close()

    fsx.files.delete(manifestPath(HOME, "s1"))
    const tree = store.tree()
    expect(tree.map((n) => n.sessionId)).toEqual(["s2"])
  })

  it("returns an empty forest with no sessions", () => {
    expect(makeStore(createMemoryFs()).store.tree()).toEqual([])
  })
})

describe("toCanonicalSession / readEnvelopes / paths", () => {
  it("projects a store session as a valid canonical session", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO, name: "titled" })
    if (!created.ok) throw new Error("expected session")
    created.value.append([
      envelope({ kind: "user-input", text: "hi" }),
      envelope({ kind: "text-delta", delta: "hello" }),
      envelope({ kind: "permission-request", requestId: "p1", toolName: "Bash" }),
      envelope({ kind: "permission-resolved", requestId: "p1", behavior: "allow" }),
    ])
    created.value.commitTurn({
      turnsAdded: 2,
      runtimeBinding: { backend: "builtin", nativeSessionId: "sdk-1" },
    })
    created.value.close()

    const canonical = store.toCanonicalSession("s1")
    if (!canonical.ok) throw new Error("expected canonical session")
    expect(canonical.value.header).toMatchObject({
      canonicalVersion: 1,
      canonicalSessionId: "s1",
      sourceRuntime: "builtin",
      title: "titled",
      turnCount: 2,
      runtimeBinding: { nativeSessionId: "sdk-1" },
    })
    expect(canonical.value.permissions?.[0]?.decision).toBe("pending")
  })

  it("reports session_not_found for an unknown id", () => {
    const result = makeStore(createMemoryFs()).store.toCanonicalSession("ghost")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("session_not_found")
  })

  it("returns the raw envelope log and the on-disk paths", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([envelope({ kind: "user-input", text: "hi" })])
    created.value.close()

    expect(store.readEnvelopes("s1")).toHaveLength(1)
    expect(store.readEnvelopes("ghost")).toEqual([])
    expect(store.paths("s1")).toEqual({
      dir: path.join(HOME, "sessions", "s1"),
      manifest: manifestPath(HOME, "s1"),
      events: eventLogPath(HOME, "s1"),
    })
    expect(store.host).toBe("host-a")
  })
})

describe("defaults when no optional wiring is supplied", () => {
  it("falls back to the real host, pid, clock, token minter and staleness window", () => {
    const fsx = createMemoryFs()
    // Only the two required options — everything else takes its production default.
    const store = createSessionStore({ home: HOME, fsx })
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.commitTurn({})
    expect(created.value.manifest.turnCount).toBe(0)

    // The default heartbeat timer must not keep the process alive; closing stops it.
    expect(store.list()[0]).toMatchObject({ sessionId: "s1", locked: true })
    created.value.close()
    expect(store.list()[0]?.locked).toBe(false)
    expect(store.host.length).toBeGreaterThan(0)
  })

  it("records the process cwd when the caller names no workspace", () => {
    const fsx = createMemoryFs()
    const store = createSessionStore({ home: HOME, fsx, heartbeatMs: 0 })
    const created = store.create("s1")
    if (!created.ok) throw new Error("expected session")
    expect(created.value.manifest.workspace).toBe(path.resolve(process.cwd()))
    created.value.close()
  })

  it("routes every file through a --session-dir override", () => {
    const fsx = createMemoryFs()
    const override = path.join(path.sep, "tmp", "store")
    const { store } = makeStore(fsx, { sessionDirOverride: override })
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([envelope({ kind: "user-input", text: "hi" })])
    created.value.commitTurn({ turnsAdded: 1 })
    created.value.close()

    expect(store.paths("s1").dir).toBe(path.join(override, "s1"))
    expect(fsx.files.has(manifestPath(HOME, "s1"))).toBe(false)
    expect(store.list().map((s) => s.sessionId)).toEqual(["s1"])
  })

  it("reports session_locked without holder detail when the lease is unreadable", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const held = store.create("s1", { cwd: REPO })
    if (!held.ok) throw new Error("expected session")
    held.value.close()

    // A lease that exists but cannot be parsed, and a store that refuses to
    // reclaim it: the conflict must still be reported, just without a holder.
    const blocked = createSessionStore({
      home: HOME,
      fsx: { ...fsx, writeFileExclusive: () => false } as MemoryFs,
      now: () => 1_000_000,
      heartbeatMs: 0,
    })
    const result = blocked.open("s1", { cwd: REPO })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("session_locked")
      expect(result.error.detail).toBeUndefined()
      expect(result.error.message).toContain("another process")
    }
  })

  it("migrates a legacy transcript that carries no runtime metadata at all", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]:
        JSON.stringify({ ts: 1, role: "user", content: "hi" }) + "\n",
    })
    const { store } = makeStore(fsx)
    const opened = store.open("s1", { cwd: REPO })
    if (!opened.ok) throw new Error("expected session")
    expect(opened.value.manifest.runtimeBinding).toBeUndefined()
    expect(opened.value.manifest.legacy).toMatchObject({ invalidLines: 0 })
    opened.value.close()
  })

  it("uses the caller's backend for a legacy session whose model survived", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]:
        JSON.stringify({
          ts: 1,
          role: "assistant",
          content: "hi",
          meta: { model: "gpt-5" },
        }) + "\n",
    })
    const { store } = makeStore(fsx)
    const opened = store.open("s1", { cwd: REPO, runtimeBinding: { backend: "codex" } })
    if (!opened.ok) throw new Error("expected session")
    expect(opened.value.manifest.runtimeBinding).toEqual({ backend: "codex", model: "gpt-5" })
    opened.value.close()
  })
})

describe("degraded and minimal sessions", () => {
  it("skips a session whose manifest is unreadable in list and tree", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    for (const id of ["s1", "s2"]) {
      const created = store.create(id, { cwd: REPO })
      if (!created.ok) throw new Error("expected session")
      created.value.close()
    }
    // A manifest that exists but does not validate must not be guessed at.
    fsx.files.set(manifestPath(HOME, "s2"), "{ corrupt")
    expect(store.list().map((s) => s.sessionId)).toEqual(["s1"])
    expect(store.tree().map((n) => n.sessionId)).toEqual(["s1"])
  })

  it("carries a fork's own name and the parent's provider, and drops the parent id", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const parent = store.create("s1", { cwd: REPO })
    if (!parent.ok) throw new Error("expected session")
    parent.value.append([envelope({ kind: "user-input", text: "one" }, "t1")])
    parent.value.commitTurn({
      turnsAdded: 1,
      runtimeBinding: {
        backend: "codex",
        nativeSessionId: "native-1",
        model: "gpt-5",
        provider: "openai",
      },
    })
    parent.value.close()

    const forked = store.branch("s1", "s2", "fork", "t1", { cwd: REPO, name: "experiment" })
    if (!forked.ok) throw new Error("expected fork")
    expect(forked.value.manifest.name).toBe("experiment")
    expect(forked.value.manifest.runtimeBinding).toEqual({
      backend: "codex",
      model: "gpt-5",
      provider: "openai",
    })
    forked.value.close()
  })

  it("branches a source that never recorded a runtime binding", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const parent = store.create("s1", { cwd: REPO })
    if (!parent.ok) throw new Error("expected session")
    parent.value.append([envelope({ kind: "user-input", text: "one" }, "t1")])
    parent.value.commitTurn({ turnsAdded: 1 })
    parent.value.close()

    const cloned = store.branch("s1", "s2", "clone")
    if (!cloned.ok) throw new Error("expected clone")
    expect(cloned.value.manifest.runtimeBinding).toBeUndefined()
    expect(cloned.value.manifest.name).toBeUndefined()
    cloned.value.close()
  })

  it("reports session_locked when the new branch id is already leased", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const parent = store.create("s1", { cwd: REPO })
    if (!parent.ok) throw new Error("expected session")
    parent.value.append([envelope({ kind: "user-input", text: "one" }, "t1")])
    parent.value.commitTurn({ turnsAdded: 1 })
    parent.value.close()

    const squatter = store.create("s2", { cwd: REPO })
    if (!squatter.ok) throw new Error("expected session")
    fsx.files.delete(manifestPath(HOME, "s2"))

    const blocked = makeStore(fsx, { pid: 200 }).store.branch("s1", "s2", "clone")
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe("session_locked")
  })

  it("projects a session with no name and no runtime binding as canonical", () => {
    const fsx = createMemoryFs()
    const { store } = makeStore(fsx)
    const created = store.create("s1", { cwd: REPO })
    if (!created.ok) throw new Error("expected session")
    created.value.append([envelope({ kind: "user-input", text: "hi" })])
    created.value.commitTurn({ turnsAdded: 1 })
    created.value.close()

    const canonical = store.toCanonicalSession("s1")
    if (!canonical.ok) throw new Error("expected canonical session")
    expect(canonical.value.header.sourceRuntime).toBe("cognia")
    expect(canonical.value.header.title).toBeUndefined()
    expect(canonical.value.header.runtimeBinding).toBeUndefined()
    expect(canonical.value.header.importFidelity).toBe("structured")
  })

  it("reports the legacy fidelity for a migrated session's canonical projection", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]:
        JSON.stringify({ ts: 1, role: "user", content: "hi" }) + "\n",
    })
    const { store } = makeStore(fsx)
    const opened = store.open("s1", { cwd: REPO })
    if (!opened.ok) throw new Error("expected session")
    opened.value.close()
    const canonical = store.toCanonicalSession("s1")
    expect(canonical.ok && canonical.value.header.importFidelity).toBe("contextual")
  })
})

describe("withoutReplayedGrants", () => {
  it("downgrades allow and allow_always to pending, keeps deny and pending", () => {
    expect(
      withoutReplayedGrants([
        { requestId: "1", toolName: "a", decision: "allow" },
        { requestId: "2", toolName: "b", decision: "allow_always" },
        { requestId: "3", toolName: "c", decision: "deny" },
        { requestId: "4", toolName: "d", decision: "pending" },
      ]).map((p) => p.decision)
    ).toEqual(["pending", "pending", "deny", "pending"])
  })

  it("copies rather than mutating its input", () => {
    const input = [{ requestId: "1", toolName: "a", decision: "allow" as const }]
    withoutReplayedGrants(input)
    expect(input[0]?.decision).toBe("allow")
  })
})
