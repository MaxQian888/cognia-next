import {
  __resetVscodeWindowHandlersForTesting,
  cancelProgress,
  clearVscodeWindowUi,
  configureVscodeWindow,
  dismissQuickInput,
  installVscodeWindowHandlers,
  type VscodeMessageRequest,
  type VscodeOpenDialogOptions,
  type VscodeSaveDialogOptions,
  type VscodeWindowPresenter,
} from "./window-handlers"
import { getVscodeLogs, clearVscodeLogs } from "./vscode-log-buffer"
import {
  __resetVscodeWindowForTesting,
  getProgress,
  getQuickInputSession,
  statusBarEntries,
} from "./window-ui-store"

type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

function call(method: string, payload: unknown, pluginId = "ext.a") {
  const handler = handlers.get(method)
  if (!handler) throw new Error(`no handler for ${method}`)
  return handler(payload, { pluginId, method, requestId: null })
}

function makePresenter() {
  const closed: string[] = []
  const presenter: jest.Mocked<VscodeWindowPresenter> = {
    showMessage: jest.fn(async (_request: VscodeMessageRequest): Promise<number | null> => 1),
    openQuickInput: jest.fn((_pluginId: string, sessionId: string) => ({
      close: () => closed.push(sessionId),
    })),
    showProgress: jest.fn(),
    hideProgress: jest.fn(),
    syncStatusBar: jest.fn(),
    outputShown: jest.fn(),
    pickOpen: jest.fn(async (_options: VscodeOpenDialogOptions): Promise<string[] | null> => [
      "file:///a",
    ]),
    pickSave: jest.fn(async (_options: VscodeSaveDialogOptions): Promise<string | null> => null),
  }
  return { presenter, closed }
}

let sent: Array<[string, string, unknown]>

beforeEach(() => {
  handlers.clear()
  __resetVscodeWindowForTesting()
  __resetVscodeWindowHandlersForTesting()
  clearVscodeLogs("ext.a")
  sent = []
  installVscodeWindowHandlers()
})

function configure() {
  const made = makePresenter()
  configureVscodeWindow({
    presenter: made.presenter,
    sendToHost: async (pluginId, method, payload) => {
      sent.push([pluginId, method, payload])
    },
  })
  return made
}

it("messages: normalised and answered with the chosen index", async () => {
  const { presenter } = configure()
  await expect(
    call("window:showMessage", {
      extensionId: "ext.a",
      severity: "bogus",
      message: "Saved",
      detail: "",
      modal: true,
      items: [{ title: "OK" }, { title: "Never", isCloseAffordance: true }, { nope: 1 }],
    })
  ).resolves.toBe(1)
  expect(presenter.showMessage).toHaveBeenCalledWith({
    pluginId: "ext.a",
    severity: "info",
    message: "Saved",
    modal: true,
    items: [{ title: "OK" }, { title: "Never", isCloseAffordance: true }],
  })
})

it("refuses another extension's request and works only with a window", () => {
  expect(() => call("window:showMessage", { extensionId: "ext.b", message: "x" })).toThrow(
    /ownership/
  )
  expect(() => call("window:showMessage", { message: "x" })).toThrow(/not available/)
})

it("quick input: open, update, user dismissal and host close", () => {
  const { presenter, closed } = configure()
  call("window:quickInputOpen", {
    extensionId: "ext.a",
    sessionId: "s1",
    kind: "pick",
    state: { value: "" },
  })
  expect(presenter.openQuickInput).toHaveBeenCalledWith("ext.a", "s1")
  call("window:quickInputUpdate", { sessionId: "s1", state: { busy: true } })
  // Another extension cannot touch it.
  call("window:quickInputUpdate", { sessionId: "s1", state: { busy: false } }, "ext.b")
  expect(getQuickInputSession("s1")?.state).toEqual({ value: "", busy: true })

  dismissQuickInput("s1")
  expect(getQuickInputSession("s1")).toBeUndefined()
  expect(sent).toEqual([
    ["ext.a", "window:quickInputEvent", { sessionId: "s1", event: { type: "hide" } }],
  ])

  call("window:quickInputOpen", { extensionId: "ext.a", sessionId: "s2", kind: "input", state: {} })
  call("window:quickInputClose", { sessionId: "s2" })
  expect(closed).toEqual(["s2"])
  expect(sent).toHaveLength(1)
})

it("progress: notifications go to the presenter, the rest to the status bar", () => {
  const { presenter } = configure()
  call("window:progressStart", {
    extensionId: "ext.a",
    handle: "n",
    location: "notification",
    title: "Build",
    cancellable: true,
  })
  call("window:progressStart", {
    extensionId: "ext.a",
    handle: "w",
    location: "statusBar",
    cancellable: true,
  })
  expect(presenter.showProgress).toHaveBeenCalledWith("ext.a", "n")
  expect(getProgress("w")?.cancellable).toBe(false)
  expect(presenter.syncStatusBar).toHaveBeenLastCalledWith(["ext.a"])
  call("window:progressReport", { handle: "n", message: "half", increment: 50 })
  expect(getProgress("n")).toMatchObject({ message: "half", percent: 50 })
  call("window:progressEnd", { handle: "n" })
  expect(presenter.hideProgress).toHaveBeenCalledWith("n")
  call("window:progressEnd", { handle: "w" })
  expect(presenter.syncStatusBar).toHaveBeenLastCalledWith([])
  cancelProgress("ext.a", "n")
  expect(sent.at(-1)).toEqual(["ext.a", "window:progressCancel", { handle: "n" }])
})

it("status bar items and messages", () => {
  const { presenter } = configure()
  call("window:statusBarItem", {
    extensionId: "ext.a",
    itemId: "i",
    state: { id: "x", alignment: 2, visible: true, text: "$(check) ok" },
  })
  call("window:setStatusBarMessage", { extensionId: "ext.a", handle: "m", text: "Saving" })
  expect(statusBarEntries("ext.a", 2)).toHaveLength(1)
  expect(statusBarEntries("ext.a", 1)).toEqual([
    { key: "message:m", kind: "message", text: "Saving" },
  ])
  call("window:clearStatusBarMessage", { extensionId: "ext.a", handle: "m" })
  call("window:statusBarItemDispose", { extensionId: "ext.a", itemId: "i" })
  expect(presenter.syncStatusBar).toHaveBeenLastCalledWith([])
})

it("output channels: whole lines, log levels, clear/replace markers and show", () => {
  const { presenter } = configure()
  const out = (op: string, extra: Record<string, unknown> = {}) =>
    call("window:outputChannel", { extensionId: "ext.a", channel: "Server", op, ...extra })
  out("append", { value: "part" })
  out("append", { value: "ial\nnext\n" })
  out("log", { level: "trace", value: "detail" })
  out("log", { level: "error", value: "boom" })
  out("append", { value: "unfinished" })
  out("show")
  out("clear")
  out("replace", { value: "fresh" })
  expect(
    getVscodeLogs("ext.a").map((entry) => `${entry.level}:${entry.kind}:${entry.message}`)
  ).toEqual([
    "info:output:Server:partial",
    "info:output:Server:next",
    "debug:output:Server:detail",
    "error:output:Server:boom",
    "info:output:Server:unfinished",
    "info:output:Server:[Server cleared]",
    "info:output:Server:[Server replaced]",
    "info:output:Server:fresh",
  ])
  expect(presenter.outputShown).toHaveBeenCalledWith("ext.a", "Server")
})

it("file dialogs go to the presenter", async () => {
  const { presenter } = configure()
  await expect(
    call("window:showOpenDialog", { extensionId: "ext.a", options: { canSelectMany: true } })
  ).resolves.toEqual(["file:///a"])
  expect(presenter.pickOpen).toHaveBeenCalledWith({ canSelectMany: true })
  await expect(call("window:showSaveDialog", { extensionId: "ext.a" })).resolves.toBeNull()
})

it("a stopped host's UI is removed without reporting dismissals", () => {
  const { presenter, closed } = configure()
  call("window:quickInputOpen", { extensionId: "ext.a", sessionId: "s", kind: "pick", state: {} })
  call("window:progressStart", { extensionId: "ext.a", handle: "n", location: "notification" })
  call("window:outputChannel", {
    extensionId: "ext.a",
    channel: "Log",
    op: "append",
    value: "tail",
  })
  clearVscodeWindowUi("ext.a")
  expect(closed).toEqual(["s"])
  expect(presenter.hideProgress).toHaveBeenCalledWith("n")
  expect(getVscodeLogs("ext.a").at(-1)?.message).toBe("tail")
  expect(sent).toEqual([])
})
