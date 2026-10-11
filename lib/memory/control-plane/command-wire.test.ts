import { parseManageMemoryCommand } from "./command-wire"

describe("parseManageMemoryCommand", () => {
  it("accepts every console command shape", () => {
    const commands = [
      {
        kind: "create",
        text: "likes tea",
        type: "semantic",
        importance: 6,
        tags: ["drink"],
        scope: "workspace",
        projectId: "p1",
        branch: "main",
      },
      { kind: "update", id: "m1", patch: { text: "new", tags: [], importance: 3, key: "k" } },
      { kind: "pin", id: "m1", pinned: false },
      { kind: "review", id: "m1", status: "verified" },
      { kind: "retrieval-feedback", id: "m1", verdict: "outdated" },
      { kind: "delete", id: "m1" },
      { kind: "restore", id: "m1" },
      { kind: "invalidate", id: "m1" },
      { kind: "invalidate", id: "m1", supersededById: "m2" },
      { kind: "restore-revision", id: "m1", revisionId: "s1" },
      { kind: "relocate", id: "m1", target: { scope: "character", characterId: "c1" } },
      { kind: "relocate", id: "m1", target: { scope: "global" } },
      { kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "keep" },
      { kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "merge", mergedText: "both" },
      { kind: "clear" },
      { kind: "clear", query: { status: "invalidated", scope: "global", type: "episodic" } },
    ]
    for (const command of commands) {
      expect(parseManageMemoryCommand(command)).toEqual(command)
    }
  })

  it("never accepts a producer identity from the wire", () => {
    expect(
      parseManageMemoryCommand({
        kind: "resolve-conflict",
        keepId: "a",
        dropId: "b",
        mode: "keep",
        actorId: "someone-else",
        commandId: "forged",
      })
    ).toEqual({ kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "keep" })
  })

  it.each([
    ["non-object", "pin"],
    ["unknown kind", { kind: "explode", id: "m1" }],
    ["empty text", { kind: "create", text: " ", type: "semantic", importance: 1, tags: [] }],
    ["bad type", { kind: "create", text: "x", type: "vibes", importance: 1, tags: [] }],
    [
      "bad scope",
      { kind: "create", text: "x", type: "semantic", importance: 1, tags: [], scope: "team" },
    ],
    ["non-string tag", { kind: "create", text: "x", type: "semantic", importance: 1, tags: [1] }],
    [
      "NaN importance",
      { kind: "create", text: "x", type: "semantic", importance: Number.NaN, tags: [] },
    ],
    ["empty patch", { kind: "update", id: "m1", patch: {} }],
    ["string pinned", { kind: "pin", id: "m1", pinned: "yes" }],
    ["bad review", { kind: "review", id: "m1", status: "maybe" }],
    ["bad verdict", { kind: "retrieval-feedback", id: "m1", verdict: "meh" }],
    ["missing id", { kind: "delete" }],
    ["workspace without project", { kind: "relocate", id: "m1", target: { scope: "workspace" } }],
    ["self conflict", { kind: "resolve-conflict", keepId: "a", dropId: "a", mode: "keep" }],
    ["merge without text", { kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "merge" }],
    ["bad clear status", { kind: "clear", query: { status: "gone" } }],
  ])("refuses %s", (_label, value) => {
    expect(parseManageMemoryCommand(value)).toBeNull()
  })

  it("refuses oversized text", () => {
    expect(
      parseManageMemoryCommand({
        kind: "update",
        id: "m1",
        patch: { text: "x".repeat(20_001) },
      })
    ).toBeNull()
  })
})
