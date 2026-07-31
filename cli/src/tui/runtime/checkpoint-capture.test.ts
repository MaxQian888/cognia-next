import { createCheckpointCapture } from "./checkpoint-capture"
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
})
