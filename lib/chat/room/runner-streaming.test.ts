import type { UIMessage } from "ai"
import { RoomStreamRegistry } from "./runner-streaming"

function msg(id: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: id }] } as UIMessage
}

describe("RoomStreamRegistry", () => {
  it("is byte-identical to a single mirror when one member streams", () => {
    const reg = new RoomStreamRegistry()
    reg.setBase("room", [msg("u1")])
    const { view, baseLength } = reg.viewOf("room", "room::char::a::t")
    expect(view.map((m) => m.id)).toEqual(["u1"])
    reg.applySubResult("room", "room::char::a::t", [...view, msg("a1")], baseLength)
    expect(reg.compose("room").map((m) => m.id)).toEqual(["u1", "a1"])
    const base = reg.fold("room", "room::char::a::t")
    expect(base.map((m) => m.id)).toEqual(["u1", "a1"])
    expect(reg.activeSubSessions("room")).toEqual([])
  })

  it("keeps two concurrent members from reading each other's partial output", () => {
    const reg = new RoomStreamRegistry()
    reg.setBase("room", [msg("u1")])
    const a = reg.viewOf("room", "sub-a")
    const b = reg.viewOf("room", "sub-b")
    reg.applySubResult("room", "sub-a", [...a.view, msg("a-partial")], a.baseLength)
    // B's next view must not contain A's partial message.
    const bAgain = reg.viewOf("room", "sub-b")
    expect(bAgain.view.map((m) => m.id)).toEqual(["u1"])
    reg.applySubResult("room", "sub-b", [...b.view, msg("b1")], b.baseLength)
    // The room transcript shows both, in start order.
    expect(reg.compose("room").map((m) => m.id)).toEqual(["u1", "a-partial", "b1"])
    // B finishes first: its slice folds, A's stays a slice after the base.
    reg.fold("room", "sub-b")
    expect(reg.compose("room").map((m) => m.id)).toEqual(["u1", "b1", "a-partial"])
    reg.fold("room", "sub-a")
    expect(reg.compose("room").map((m) => m.id)).toEqual(["u1", "b1", "a-partial"])
  })

  it("lets a caller fold a post-processed final list instead of the raw slice", () => {
    const reg = new RoomStreamRegistry()
    reg.setBase("room", [msg("u1")])
    const view = reg.viewOf("room", "sub-a")
    reg.applySubResult("room", "sub-a", [...view.view, msg("a1")], view.baseLength)
    const base = reg.fold("room", "sub-a", [msg("u1"), msg("a1-merged")])
    expect(base.map((m) => m.id)).toEqual(["u1", "a1-merged"])
  })

  it("adopts a rewritten base message so the change survives the fold", () => {
    const reg = new RoomStreamRegistry()
    const original = msg("u1")
    reg.setBase("room", [original])
    const view = reg.viewOf("room", "sub-a")
    const rewritten = { ...original, parts: [{ type: "text", text: "edited" }] } as UIMessage
    reg.applySubResult("room", "sub-a", [rewritten, msg("a1")], view.baseLength)
    expect(reg.baseOf("room")?.[0]).toBe(rewritten)
    expect(reg.compose("room").map((m) => m.id)).toEqual(["u1", "a1"])
  })

  it("discards an interrupted slice and releases the room", () => {
    const reg = new RoomStreamRegistry()
    reg.setBase("room", [])
    const view = reg.viewOf("room", "sub-a")
    reg.applySubResult("room", "sub-a", [msg("a1")], view.baseLength)
    reg.discard("room", "sub-a")
    expect(reg.compose("room")).toEqual([])
    reg.release("room")
    expect(reg.has("room")).toBe(false)
    expect(reg.compose("room")).toEqual([])
  })
})
