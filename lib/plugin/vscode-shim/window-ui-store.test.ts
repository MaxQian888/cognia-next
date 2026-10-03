import {
  __resetVscodeWindowForTesting,
  clearStatusBarMessage,
  clearVscodeWindowForPlugin,
  closeQuickInputSession,
  endProgress,
  filterQuickPickItems,
  getProgress,
  getQuickInputSession,
  getVscodeWindowRevision,
  openQuickInputSession,
  pluginsWithStatusBarEntries,
  reportProgress,
  setStatusBarItem,
  setStatusBarMessage,
  startProgress,
  statusBarEntries,
  subscribeVscodeWindow,
  updateQuickInputSession,
  type StatusBarItemState,
} from "./window-ui-store"

const item = (overrides: Partial<StatusBarItemState> = {}): StatusBarItemState => ({
  id: "a",
  alignment: 1,
  visible: true,
  text: "A",
  ...overrides,
})

beforeEach(() => __resetVscodeWindowForTesting())

describe("quick input sessions", () => {
  it("merges updates into the open session and notifies", () => {
    const seen = jest.fn()
    subscribeVscodeWindow(seen)
    openQuickInputSession({
      sessionId: "s",
      pluginId: "p",
      kind: "pick",
      state: { value: "", busy: true },
    })
    expect(updateQuickInputSession("s", { busy: false, items: [{ label: "x" }] })).toBe(true)
    expect(getQuickInputSession("s")?.state).toEqual({
      value: "",
      busy: false,
      items: [{ label: "x" }],
    })
    expect(updateQuickInputSession("missing", {})).toBe(false)
    expect(closeQuickInputSession("s")?.pluginId).toBe("p")
    expect(closeQuickInputSession("s")).toBeUndefined()
    expect(seen).toHaveBeenCalledTimes(3)
    expect(getVscodeWindowRevision()).toBe(3)
  })
})

describe("status bar", () => {
  it("orders by priority, leads the left side with the newest message and status progress", () => {
    setStatusBarItem("p", "low", item({ id: "low", priority: 1 }))
    setStatusBarItem("p", "high", item({ id: "high", priority: 9 }))
    setStatusBarItem("p", "hidden", item({ id: "hidden", visible: false }))
    setStatusBarItem("p", "right", item({ id: "right", alignment: 2 }))
    setStatusBarMessage("p", "m1", "old")
    setStatusBarMessage("p", "m2", "new")
    startProgress({
      handle: "h",
      pluginId: "p",
      location: "statusBar",
      title: "Index",
      cancellable: false,
    })
    expect(statusBarEntries("p", 1).map((entry) => entry.key)).toEqual([
      "message:m2",
      "progress:h",
      "item:high",
      "item:low",
    ])
    expect(statusBarEntries("p", 2).map((entry) => entry.key)).toEqual(["item:right"])
    clearStatusBarMessage("p", "m2")
    expect(statusBarEntries("p", 1)[0]).toMatchObject({ kind: "message", text: "old" })
  })

  it("lists only plugins with something visible", () => {
    setStatusBarItem("hidden-only", "x", item({ visible: false }))
    setStatusBarMessage("messages", "m", "hi")
    startProgress({ handle: "h", pluginId: "progress", location: "statusBar", cancellable: false })
    startProgress({ handle: "n", pluginId: "toast", location: "notification", cancellable: false })
    expect(pluginsWithStatusBarEntries().sort()).toEqual(["messages", "progress"])
  })
})

describe("progress", () => {
  it("accumulates increments within 0–100 and keeps the last message", () => {
    startProgress({ handle: "h", pluginId: "p", location: "notification", cancellable: true })
    reportProgress("h", { message: "one", increment: 60 })
    reportProgress("h", { increment: 70 })
    expect(getProgress("h")).toMatchObject({ message: "one", percent: 100 })
    reportProgress("missing", { increment: 1 })
    expect(endProgress("h")?.handle).toBe("h")
    expect(endProgress("h")).toBeUndefined()
  })
})

it("clears everything a plugin showed", () => {
  openQuickInputSession({ sessionId: "s", pluginId: "p", kind: "input", state: {} })
  openQuickInputSession({ sessionId: "other", pluginId: "q", kind: "input", state: {} })
  startProgress({ handle: "h", pluginId: "p", location: "notification", cancellable: false })
  setStatusBarItem("p", "i", item())
  const cleared = clearVscodeWindowForPlugin("p")
  expect(cleared.quickInputs.map((session) => session.sessionId)).toEqual(["s"])
  expect(cleared.progress.map((state) => state.handle)).toEqual(["h"])
  expect(getQuickInputSession("other")).toBeDefined()
  expect(statusBarEntries("p", 1)).toEqual([])
})

describe("filterQuickPickItems", () => {
  const items = [
    { label: "Group", separator: true },
    { label: "Open File", description: "workbench" },
    { label: "Close", detail: "close the file" },
    { label: "Always", alwaysShow: true },
    { label: "Other", separator: true },
    { label: "Format document" },
  ]

  it("keeps everything without a query", () => {
    expect(filterQuickPickItems(items, "  ")).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("matches characters in order, label matches first", () => {
    expect(filterQuickPickItems(items, "of")).toEqual([1, 3])
    expect(filterQuickPickItems(items, "fo")).toEqual([5, 3])
    expect(filterQuickPickItems(items, "file", { matchOnDetail: true })).toEqual([1, 2, 3])
    expect(filterQuickPickItems(items, "wb", { matchOnDescription: true })).toEqual([1, 3])
  })

  it("without sorting, keeps separators that head a visible item", () => {
    expect(filterQuickPickItems(items, "fo", { sortByLabel: false })).toEqual([0, 3, 4, 5])
    expect(filterQuickPickItems(items, "doc", { sortByLabel: false })).toEqual([0, 3, 4, 5])
  })
})
