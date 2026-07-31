import {
  registerAppShortcut,
  getAppRegistration,
  listAppRegistrations,
  matchingAppShortcuts,
  __resetAppRuntimeForTesting,
  type AppShortcutRegistration,
} from "./app-runtime"

function reg(id: string, extra: Partial<AppShortcutRegistration> = {}): AppShortcutRegistration {
  return { id, handler: jest.fn(), ...extra }
}

describe("app-runtime", () => {
  beforeEach(() => __resetAppRuntimeForTesting())

  it("registers and resolves a handler by id", () => {
    const r = reg("a")
    registerAppShortcut(r)
    expect(getAppRegistration("a")).toBe(r)
    expect(listAppRegistrations()).toEqual([r])
  })

  it("last registration for an id wins", () => {
    registerAppShortcut(reg("a"))
    const second = reg("a")
    registerAppShortcut(second)
    expect(getAppRegistration("a")).toBe(second)
    expect(listAppRegistrations()).toHaveLength(1)
  })

  it("disposer removes the registration", () => {
    const dispose = registerAppShortcut(reg("a"))
    dispose()
    expect(getAppRegistration("a")).toBeUndefined()
  })

  it("a stale disposer does not clobber a remounted registration", () => {
    const first = reg("a")
    const disposeFirst = registerAppShortcut(first)
    const second = reg("a")
    registerAppShortcut(second)
    disposeFirst() // first unmounts after second mounted — must NOT delete second
    expect(getAppRegistration("a")).toBe(second)
  })

  describe("matchingAppShortcuts", () => {
    const accepted: Record<string, string[]> = {
      a: ["ctrl+k"],
      b: ["ctrl+k", "ctrl+shift+k"],
      c: ["ctrl+j"],
    }
    const resolve = (id: string) => accepted[id] ?? []

    it("returns every registration whose accepted chords include the pressed chord", () => {
      registerAppShortcut(reg("a"))
      registerAppShortcut(reg("b"))
      registerAppShortcut(reg("c"))
      const hits = matchingAppShortcuts("ctrl+k", resolve)
      expect(hits.map((r) => r.id)).toEqual(["a", "b"])
    })

    it("returns an empty array when nothing matches", () => {
      registerAppShortcut(reg("c"))
      expect(matchingAppShortcuts("ctrl+k", resolve)).toEqual([])
    })

    it("preserves registration order", () => {
      registerAppShortcut(reg("b"))
      registerAppShortcut(reg("a"))
      const hits = matchingAppShortcuts("ctrl+k", resolve)
      expect(hits.map((r) => r.id)).toEqual(["b", "a"])
    })
  })
})
