import { resolveSessionWorkspace } from "./session-workspace"

const projects = [
  { id: "proj-a", name: "A" },
  { id: "proj-b", name: "B" },
]

describe("resolveSessionWorkspace", () => {
  it("prefers the session's own workspace over the active one", () => {
    expect(resolveSessionWorkspace({ projectId: "proj-b" }, projects, "proj-a")).toEqual({
      id: "proj-b",
      name: "B",
    })
  })

  it("falls back to the active workspace when the session has none", () => {
    expect(resolveSessionWorkspace({}, projects, "proj-a")).toEqual({ id: "proj-a", name: "A" })
    expect(resolveSessionWorkspace(null, projects, "proj-a")).toEqual({ id: "proj-a", name: "A" })
    expect(resolveSessionWorkspace(undefined, projects, "proj-a")).toEqual({
      id: "proj-a",
      name: "A",
    })
  })

  it("returns null — never the active workspace — for an unknown session workspace", () => {
    // A deleted / not-yet-loaded workspace must not silently borrow another
    // project's roots; that is the mis-attribution this helper prevents.
    expect(resolveSessionWorkspace({ projectId: "proj-gone" }, projects, "proj-a")).toBeNull()
  })

  it("returns null when nothing resolves", () => {
    expect(resolveSessionWorkspace({}, projects, null)).toBeNull()
    expect(resolveSessionWorkspace({}, projects, undefined)).toBeNull()
    expect(resolveSessionWorkspace({ projectId: "proj-a" }, [], "proj-a")).toBeNull()
  })
})
