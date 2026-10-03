import {
  __resetWebviewBridgeForTesting,
  addWebview,
  attachWebviewFrame,
  DEFAULT_WEBVIEW_OPTIONS,
  getSelectedWebview,
  getWebview,
  listWebviews,
  postToWebview,
  removeWebview,
  selectWebview,
  setWebviewState,
  subscribeWebviews,
  updateWebview,
} from "./webview-bridge"

const panel = (handle: string) => ({
  handle,
  pluginId: "acme.ext",
  kind: "panel" as const,
  viewType: "acme.preview",
  title: handle,
  html: "",
  options: DEFAULT_WEBVIEW_OPTIONS,
})

beforeEach(() => __resetWebviewBridgeForTesting())

it("adds webviews in order, selecting a new panel unless asked not to", () => {
  const changes = jest.fn()
  subscribeWebviews(changes)
  addWebview(panel("a"), { select: false })
  expect(getSelectedWebview()).toBe("a")
  addWebview(panel("b"), { select: false })
  expect(getSelectedWebview()).toBe("a")
  addWebview(panel("c"), { select: true })
  expect(getSelectedWebview()).toBe("c")
  expect(listWebviews().map((webview) => webview.handle)).toEqual(["a", "b", "c"])
  expect(changes).toHaveBeenCalledTimes(3)
  expect(getWebview("a")).toMatchObject({ revision: 0, resolved: true, state: undefined })
  const view = addWebview({ ...panel("v"), kind: "view", token: "t" }, { select: false })
  expect(view.resolved).toBe(false)
})

it("keeps the snapshot stable until something changes", () => {
  addWebview(panel("a"), { select: true })
  const first = listWebviews()
  expect(listWebviews()).toBe(first)
  updateWebview("a", { title: "A" })
  expect(listWebviews()).not.toBe(first)
})

it("reloads on new html or options, even the same html, but not on a title", () => {
  addWebview(panel("a"), { select: true })
  updateWebview("a", { html: "<p>x</p>" })
  updateWebview("a", { html: "<p>x</p>" })
  updateWebview("a", { options: { ...DEFAULT_WEBVIEW_OPTIONS, enableScripts: true } })
  updateWebview("a", {
    title: "T",
    description: "d",
    badge: { value: 2, tooltip: "two" },
    resolved: true,
  })
  expect(getWebview("a")).toMatchObject({
    revision: 3,
    html: "<p>x</p>",
    title: "T",
    description: "d",
    badge: { value: 2, tooltip: "two" },
  })
  updateWebview("a", { description: null, badge: null })
  expect(getWebview("a")?.description).toBeUndefined()
  expect(getWebview("a")?.badge).toBeUndefined()
  expect(updateWebview("missing", { title: "x" })).toBe(false)
})

it("moves the selection to the next tab, else the previous one, when the shown one goes", () => {
  for (const handle of ["a", "b", "c"]) addWebview(panel(handle), { select: false })
  selectWebview("b")
  removeWebview("b")
  expect(getSelectedWebview()).toBe("c")
  removeWebview("c")
  expect(getSelectedWebview()).toBe("a")
  removeWebview("a")
  expect(getSelectedWebview()).toBeNull()
  expect(removeWebview("a")).toBeUndefined()
  expect(selectWebview("a")).toBe(false)
})

it("keeps the frame's saved state, and delivers messages only to a live frame", () => {
  addWebview(panel("a"), { select: true })
  setWebviewState("a", { count: 1 })
  expect(getWebview("a")?.state).toEqual({ count: 1 })
  expect(postToWebview("a", "hi")).toBe(false)
  const seen: unknown[] = []
  const detach = attachWebviewFrame("a", (message) => {
    seen.push(message)
    return true
  })
  expect(postToWebview("a", "hi")).toBe(true)
  // A newer frame replaces it; the old one's detach leaves the new one.
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  const detachNewer = attachWebviewFrame("a", () => {
    throw new Error("broken frame")
  })
  detach()
  expect(postToWebview("a", "again")).toBe(false)
  detachNewer()
  expect(postToWebview("a", "again")).toBe(false)
  expect(seen).toEqual(["hi"])
  // A frame that throws counts as not delivered, and says so.
  expect(warn).toHaveBeenCalledTimes(1)
  warn.mockRestore()
  attachWebviewFrame("a", () => true)
  removeWebview("a")
  expect(postToWebview("a", "after")).toBe(false)
})
