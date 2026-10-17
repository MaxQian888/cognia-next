import { createCheckpointCapture, preMutationSnapshotsOf } from "./checkpoint-capture"
import type { CheckpointFs } from "./checkpoint-store"

function memFs(): CheckpointFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    read: (p) => (files.has(p) ? files.get(p)! : null),
    write: (p, d) => void files.set(p, d),
    rm: (p) => void files.delete(p),
    exists: (p) => files.has(p),
    mkdirp: () => {},
    listDir: (d) => [...files.keys()].filter((k) => k.startsWith(d)),
  }
}

describe("createCheckpointCapture", () => {
  it("captures pre-turn cell counts + file shadows and lists newest-first", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "v0")
    let clock = 0
    const cap = createCheckpointCapture({
      home: "/home",
      getSessionId: () => "s1",
      fs,
      now: () => ++clock,
    })

    cap.beginTurn(0, "p1")
    cap.onToolCall("Edit", { file_path: "/proj/a.ts" }) // records v0
    fs.files.set("/proj/a.ts", "v1") // turn 1 edits the file

    cap.beginTurn(2, "p2") // commits p1 (cellCount 0, shadow a=v0)
    cap.onToolCall("Write", { file_path: "/proj/a.ts" }) // records v1
    fs.files.set("/proj/a.ts", "v2")

    const checkpoints = cap.list() // flush p2 (cellCount 2, shadow a=v1)
    expect(checkpoints.map((c) => c.cellCount)).toEqual([2, 0]) // newest first
    expect(checkpoints[0].label).toBe("p2")
    expect(checkpoints[1].files[0].absPath).toBe("/proj/a.ts")
  })

  it("restores files from a chosen checkpoint", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "v0")
    const cap = createCheckpointCapture({
      home: "/home",
      getSessionId: () => "s1",
      fs,
      now: () => 1,
    })
    cap.beginTurn(0, "p1")
    cap.onToolCall("Edit", { file_path: "/proj/a.ts" })
    fs.files.set("/proj/a.ts", "v1")
    const [p1] = cap.list()
    cap.store.restore(p1, { files: true, conversation: false })
    expect(fs.read("/proj/a.ts")).toBe("v0")
  })

  it("ignores non-mutating tools and inputs without a path", () => {
    const fs = memFs()
    const cap = createCheckpointCapture({
      home: "/home",
      getSessionId: () => "s1",
      fs,
      now: () => 1,
    })
    cap.beginTurn(0, "p1")
    cap.onToolCall("Grep", { pattern: "x" }) // not mutating
    cap.onToolCall("Edit", { pattern: "no path" }) // mutating but no path
    const [cp] = cap.list()
    expect(cp.files).toEqual([])
  })

  it("continues numbering after a restart so older checkpoints stay addressable", () => {
    const fs = memFs()
    fs.files.set("/proj/a.ts", "original")
    let clock = 0
    const make = () =>
      createCheckpointCapture({ home: "/home", getSessionId: () => "s1", fs, now: () => ++clock })

    const first = make()
    first.beginTurn(0, "edit")
    first.onToolCall("Edit", { file_path: "/proj/a.ts" })
    fs.files.set("/proj/a.ts", "changed")
    const [before] = first.list()
    expect(before.seq).toBe(0)

    // --continue: a new capture over the same session and the same disk.
    const second = make()
    second.beginTurn(2, "after restart")
    fs.files.set("/proj/a.ts", "after-restart")
    const listed = second.list()
    expect(listed.map((c) => c.seq)).toEqual([1, 0])

    const target = listed.find((c) => c.seq === 0)!
    expect(target.label).toBe("edit")
    second.store.restore(target, { files: true, conversation: false })
    expect(fs.read("/proj/a.ts")).toBe("original")
  })

  it("numbers each session from its own committed checkpoints", () => {
    const fs = memFs()
    let sid = "s1"
    const cap = createCheckpointCapture({
      home: "/home",
      getSessionId: () => sid,
      fs,
      now: () => 1,
    })
    cap.beginTurn(0, "a")
    cap.beginTurn(1, "b")
    expect(cap.list().map((c) => c.seq)).toEqual([1, 0])
    sid = "s2"
    cap.beginTurn(0, "fresh")
    expect(cap.list().map((c) => c.seq)).toEqual([0])
  })
})

describe("pre-mutation frames", () => {
  it("decodes the sidecar frame and drops malformed entries", () => {
    const snapshots = preMutationSnapshotsOf({
      type: "file_pre_mutation",
      entries: [
        { path: "/w/a", before: "file", contentBase64: Buffer.from("hi").toString("base64") },
        { path: "/w/b", before: "absent" },
        { path: "/w/c", before: "directory" },
        { path: "/w/d", before: "file", omitted: "too-large" },
        { path: "relative", before: "absent" },
        { path: "/w/e", before: "file" },
        { path: "/w/f", before: "weird" },
        null,
      ],
    })
    expect(snapshots.map((s) => [s.absPath, s.before, s.omitted])).toEqual([
      ["/w/a", "file", undefined],
      ["/w/b", "absent", undefined],
      ["/w/c", "directory", undefined],
      ["/w/d", "file", "too-large"],
    ])
    expect(Buffer.from(snapshots[0]!.content!).toString()).toBe("hi")
    expect(preMutationSnapshotsOf({ type: "log" })).toEqual([])
    expect(preMutationSnapshotsOf(null)).toEqual([])
  })

  it("records frame snapshots into the open turn so a rewind restores them", () => {
    const fs = memFs()
    fs.files.set("/w/existing.txt", "CHANGED")
    fs.files.set("/w/created.txt", "new file")
    const cap = createCheckpointCapture({ home: "/home", getSessionId: () => "s1", fs })
    cap.beginTurn(2, "edit things")
    cap.onPreMutationFrame({
      type: "file_pre_mutation",
      sessionId: "s1",
      entries: [
        {
          path: "/w/existing.txt",
          before: "file",
          contentBase64: Buffer.from("ORIGINAL").toString("base64"),
        },
        { path: "/w/created.txt", before: "absent" },
      ],
    })
    const [cp] = cap.list()
    expect(cp!.files.map((f) => f.absPath).sort()).toEqual(["/w/created.txt", "/w/existing.txt"])
    cap.store.restore(cp!, { files: true, conversation: false })
    expect(fs.read("/w/existing.txt")).toBe("ORIGINAL")
    expect(fs.exists("/w/created.txt")).toBe(false)
  })
})
