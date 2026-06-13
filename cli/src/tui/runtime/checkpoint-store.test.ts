import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createCheckpointStore, realCheckpointFs, type CheckpointFs } from "./checkpoint-store"

/** Build an on-disk checkpoint path the same way the store does (platform sep). */
function diskPath(...parts: string[]): string {
  return path.join("/home", "checkpoints", ...parts)
}

function memFs(): CheckpointFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    read: (p: string) => (files.has(p) ? files.get(p)! : null),
    write: (p: string, d: string) => void files.set(p, d),
    rm: (p: string) => void files.delete(p),
    exists: (p: string) => files.has(p),
    mkdirp: () => {},
    listDir: (d: string) => [...files.keys()].filter((k) => k.startsWith(d)),
  }
}

describe("checkpoint store", () => {
  it("records a pre-mutation backup once per segment", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    fs.files.set("/proj/a.ts", "edited")
    store.recordPreMutation("sess1", "/proj/a.ts") // no-op second time
    const cp = store.commitCheckpoint("sess1", { cellCount: 4, label: "t1", ts: 1, seq: 1 })
    expect(cp.files).toHaveLength(1)
    expect(cp.files[0].absPath).toBe("/proj/a.ts")
  })

  it("restores file contents from a checkpoint", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    fs.files.set("/proj/a.ts", "edited")
    const cp = store.commitCheckpoint("sess1", { cellCount: 4, label: "t1", ts: 1, seq: 1 })
    store.restore(cp, { files: true, conversation: false })
    expect(fs.read("/proj/a.ts")).toBe("original")
  })

  it("records a tombstone for a file that did not exist (restore deletes)", () => {
    const fs = memFs()
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/new.ts")
    fs.files.set("/proj/new.ts", "created")
    const cp = store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    store.restore(cp, { files: true, conversation: false })
    expect(fs.exists("/proj/new.ts")).toBe(false)
  })

  it("listCheckpoints returns committed checkpoints newest-first", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    store.commitCheckpoint("sess1", { cellCount: 1, label: "first", ts: 10, seq: 1 })
    // commit already opened the next segment.
    store.recordPreMutation("sess1", "/proj/a.ts")
    store.commitCheckpoint("sess1", { cellCount: 2, label: "second", ts: 20, seq: 2 })
    const list = store.listCheckpoints("sess1")
    expect(list).toHaveLength(2)
    expect(list[0].label).toBe("second")
    expect(list[1].label).toBe("first")
  })

  it("committing opens the next segment (subsequent recordPreMutation lands in a new segment)", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "v1")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    const cp1 = store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    expect(cp1.files[0].shadowPath).not.toBeNull()

    // Mutate again — a new segment is already open after the commit, so this is
    // captured fresh rather than deduped against the previous segment.
    fs.files.set("/proj/a.ts", "v2")
    store.recordPreMutation("sess1", "/proj/a.ts")
    const cp2 = store.commitCheckpoint("sess1", { cellCount: 2, label: "t2", ts: 2, seq: 2 })
    expect(cp2.files).toHaveLength(1)

    // The second checkpoint backed up "v2" (the bytes at the start of segment 2).
    fs.files.set("/proj/a.ts", "v3")
    store.restore(cp2, { files: true, conversation: false })
    expect(fs.read("/proj/a.ts")).toBe("v2")
  })

  it("restore with {files:false} does nothing to files", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    fs.files.set("/proj/a.ts", "edited")
    const cp = store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    store.restore(cp, { files: false, conversation: true })
    expect(fs.read("/proj/a.ts")).toBe("edited")
  })

  it("recordPreMutation without an open segment opens one implicitly", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    // No openSegment() call.
    store.recordPreMutation("sess1", "/proj/a.ts")
    fs.files.set("/proj/a.ts", "edited")
    const cp = store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    expect(cp.files).toHaveLength(1)
    store.restore(cp, { files: true, conversation: false })
    expect(fs.read("/proj/a.ts")).toBe("original")
  })

  it("commit with no recorded mutations yields an empty checkpoint", () => {
    const fs = memFs()
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    const cp = store.commitCheckpoint("sess1", { cellCount: 0, label: "empty", ts: 5, seq: 1 })
    expect(cp.files).toHaveLength(0)
    expect(cp.label).toBe("empty")
    expect(cp.seq).toBe(1)
    expect(cp.ts).toBe(5)
  })

  it("isolates segments per session", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "a-orig")
    fs.files.set("/proj/b.ts", "b-orig")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sessA")
    store.openSegment("sessB")
    store.recordPreMutation("sessA", "/proj/a.ts")
    store.recordPreMutation("sessB", "/proj/b.ts")
    const cpA = store.commitCheckpoint("sessA", { cellCount: 1, label: "a", ts: 1, seq: 1 })
    const cpB = store.commitCheckpoint("sessB", { cellCount: 1, label: "b", ts: 1, seq: 1 })
    expect(cpA.files[0].absPath).toBe("/proj/a.ts")
    expect(cpB.files[0].absPath).toBe("/proj/b.ts")
    expect(store.listCheckpoints("sessA")).toHaveLength(1)
    expect(store.listCheckpoints("sessB")).toHaveLength(1)
  })

  it("listCheckpoints returns an empty array for an unknown session", () => {
    const fs = memFs()
    const store = createCheckpointStore({ home: "/home", fs })
    expect(store.listCheckpoints("nope")).toEqual([])
  })

  it("listCheckpoints reads committed meta.json from disk (survives a fresh store)", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    store.commitCheckpoint("sess1", { cellCount: 1, label: "persisted", ts: 7, seq: 1 })

    // A brand-new store instance over the same fs sees the committed checkpoint.
    const reopened = createCheckpointStore({ home: "/home", fs })
    const list = reopened.listCheckpoints("sess1")
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe("persisted")
    expect(list[0].files[0].absPath).toBe("/proj/a.ts")
  })

  it("skips a corrupt meta.json rather than throwing", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    store.commitCheckpoint("sess1", { cellCount: 1, label: "good", ts: 1, seq: 1 })
    // Corrupt the committed meta on a second segment.
    fs.files.set(diskPath("sess1", "9", "meta.json"), "{not json")
    const list = store.listCheckpoints("sess1")
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe("good")
  })

  it("ignores non-numeric directory entries when computing the next index", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    // Stray, non-segment entry directly under the session dir.
    fs.files.set(diskPath("sess1", "notes.txt"), "hi")
    const store = createCheckpointStore({ home: "/home", fs })
    store.recordPreMutation("sess1", "/proj/a.ts")
    const cp = store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    // First real segment index is 0 (the stray entry is ignored).
    expect(cp.id).toBe("sess1-0")
  })

  it("resumes the next index above committed segments after reopening", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const first = createCheckpointStore({ home: "/home", fs })
    first.openSegment("sess1")
    first.recordPreMutation("sess1", "/proj/a.ts")
    first.commitCheckpoint("sess1", { cellCount: 1, label: "s0", ts: 1, seq: 1 })
    first.recordPreMutation("sess1", "/proj/a.ts")
    first.commitCheckpoint("sess1", { cellCount: 1, label: "s1", ts: 2, seq: 2 })

    // A fresh store must scan the two committed segments (0 and 1) and resume at 2.
    const reopened = createCheckpointStore({ home: "/home", fs })
    reopened.recordPreMutation("sess1", "/proj/a.ts")
    const cp = reopened.commitCheckpoint("sess1", { cellCount: 1, label: "s2", ts: 3, seq: 3 })
    expect(cp.id).toBe("sess1-2")
  })

  it("skips restore when the shadow bytes are missing", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    const cp = store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    // Delete the shadow copy out from under the checkpoint.
    fs.rm(cp.files[0].shadowPath!)
    fs.files.set("/proj/a.ts", "edited")
    store.restore(cp, { files: true, conversation: false })
    // Best-effort: the live file is left as-is rather than wiped.
    expect(fs.read("/proj/a.ts")).toBe("edited")
  })

  it("reopened store allocates segment 0 when the session dir is empty", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    // A reopened store with no committed segments must scan disk (empty) and
    // start at index 0.
    const store = createCheckpointStore({ home: "/home", fs })
    store.recordPreMutation("sess1", "/proj/a.ts")
    const cp = store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    expect(cp.id).toBe("sess1-0")
  })

  it("skips a meta entry that reads back as null", () => {
    const fs = memFs()
    // A listed meta.json whose read returns null (e.g. race/removal) is skipped.
    fs.files.set(diskPath("sess1", "0", "meta.json"), "x")
    const realRead = fs.read
    fs.read = (p: string) => (p.endsWith("meta.json") ? null : realRead(p))
    const store = createCheckpointStore({ home: "/home", fs })
    expect(store.listCheckpoints("sess1")).toEqual([])
  })

  it("breaks newest-first ties by higher seq when ts is equal", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    store.commitCheckpoint("sess1", { cellCount: 1, label: "lo", ts: 5, seq: 1 })
    store.recordPreMutation("sess1", "/proj/a.ts")
    store.commitCheckpoint("sess1", { cellCount: 1, label: "hi", ts: 5, seq: 2 })
    const list = store.listCheckpoints("sess1")
    expect(list.map((c) => c.label)).toEqual(["hi", "lo"])
  })

  it("restore reads shadow bytes back from a reopened store", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    const store = createCheckpointStore({ home: "/home", fs })
    store.openSegment("sess1")
    store.recordPreMutation("sess1", "/proj/a.ts")
    store.commitCheckpoint("sess1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
    fs.files.set("/proj/a.ts", "edited")

    const reopened = createCheckpointStore({ home: "/home", fs })
    const cp = reopened.listCheckpoints("sess1")[0]
    reopened.restore(cp, { files: true, conversation: false })
    expect(fs.read("/proj/a.ts")).toBe("original")
  })
})

describe("realCheckpointFs", () => {
  it("round-trips a real checkpoint on disk (write/read/list/restore/rm)", () => {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cp-"))
    try {
      const target = path.join(home, "a.ts")
      nodeFs.writeFileSync(target, "v0")
      const store = createCheckpointStore({ home, fs: realCheckpointFs })
      store.openSegment("s1")
      store.recordPreMutation("s1", target)
      nodeFs.writeFileSync(target, "v1")
      const cp = store.commitCheckpoint("s1", { cellCount: 1, label: "t1", ts: 1, seq: 1 })
      expect(realCheckpointFs.exists(cp.files[0].shadowPath as string)).toBe(true)

      const fresh = createCheckpointStore({ home, fs: realCheckpointFs })
      const listed = fresh.listCheckpoints("s1")
      expect(listed).toHaveLength(1)
      fresh.restore(listed[0], { files: true, conversation: false })
      expect(nodeFs.readFileSync(target, "utf8")).toBe("v0")
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("read returns null for a missing file and listDir [] for a missing dir", () => {
    expect(realCheckpointFs.read(path.join(os.tmpdir(), "nope-cp-xyz"))).toBeNull()
    expect(realCheckpointFs.listDir(path.join(os.tmpdir(), "missing-cp-dir-xyz"))).toEqual([])
  })
})
