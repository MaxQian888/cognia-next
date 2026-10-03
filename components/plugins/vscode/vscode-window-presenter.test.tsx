/**
 * @jest-environment jsdom
 */

const mockToast = Object.assign(jest.fn(), {
  custom: jest.fn(
    (_render: (id: string) => unknown, _options?: Record<string, unknown>) => "toast-1"
  ),
  dismiss: jest.fn(),
})
jest.mock("sonner", () => ({
  get toast() {
    return mockToast
  },
}))

const mockRegister = jest.fn((_point: string, _component: unknown) => jest.fn())
jest.mock("@/lib/plugin/api/extension-api", () => ({
  createExtensionAPI: (pluginId: string) => ({
    registerExtension: (point: string, component: unknown) =>
      mockRegister(`${pluginId}:${point}`, component),
  }),
}))

const mockNavigate = jest.fn()
jest.mock("@/lib/plugin/api/navigation-request", () => ({
  requestPluginNavigation: (...args: unknown[]) => mockNavigate(...args),
}))

const mockPickOpen = jest.fn(async () => ["file:///x"])
jest.mock("@/lib/plugin/vscode-shim/native-dialogs", () => ({
  pickOpenUris: (...args: unknown[]) => mockPickOpen(...(args as [])),
  pickSaveUri: jest.fn(async () => null),
}))

import { usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"

import { createVscodeWindowPresenter, OUTPUT_NOTICE_INTERVAL_MS } from "./vscode-window-presenter"

const request = {
  pluginId: "ext.a",
  severity: "info" as const,
  message: "Hi",
  modal: false,
  items: [{ title: "OK" }],
}

beforeEach(() => {
  jest.clearAllMocks()
  usePluginModalStore.setState({ stack: [] })
})

function lastToastOptions() {
  return mockToast.custom.mock.calls.at(-1)?.[1] as Record<string, unknown>
}

it("a non-modal message waits for a choice and treats a dismissal as none", async () => {
  const presenter = createVscodeWindowPresenter()
  const answer = presenter.showMessage(request)
  expect(lastToastOptions().duration).toBe(Number.POSITIVE_INFINITY)
  ;(lastToastOptions().onDismiss as () => void)()
  await expect(answer).resolves.toBeNull()

  void presenter.showMessage({ ...request, items: [] })
  expect(lastToastOptions().duration).toBe(10_000)
})

it("a modal message and a quick input open in the plugin modal stack", async () => {
  const presenter = createVscodeWindowPresenter()
  const answer = presenter.showMessage({ ...request, modal: true })
  const [entry] = usePluginModalStore.getState().stack as unknown as Array<{
    pluginId: string
    args: { settle: (index: number | null) => void }
  }>
  expect(entry.pluginId).toBe("ext.a")
  entry.args.settle(0)
  await expect(answer).resolves.toBe(0)

  const handle = presenter.openQuickInput("ext.a", "s1")
  const opened = usePluginModalStore.getState().stack as unknown as Array<{
    args: { sessionId?: string }
  }>
  expect(opened.some((modal) => modal.args.sessionId === "s1")).toBe(true)
  handle.close()
  expect(
    (
      usePluginModalStore.getState().stack as unknown as Array<{ args: { sessionId?: string } }>
    ).some((modal) => modal.args.sessionId === "s1")
  ).toBe(false)
})

it("asks about an external link in the plugin modal stack and answers once", async () => {
  const presenter = createVscodeWindowPresenter()
  const answer = presenter.confirmOpenExternal("ext.a", "https://example.com")
  const [entry] = usePluginModalStore.getState().stack as unknown as Array<{
    pluginId: string
    args: { url: string; settle: (choice: string | null) => void }
  }>
  expect(entry.pluginId).toBe("ext.a")
  expect(entry.args.url).toBe("https://example.com")
  entry.args.settle("open")
  entry.args.settle(null)
  await expect(answer).resolves.toBe("open")
})

it("progress toasts are keyed by handle", () => {
  const presenter = createVscodeWindowPresenter()
  presenter.showProgress("ext.a", "h1")
  expect(lastToastOptions()).toMatchObject({ id: "h1", duration: Number.POSITIVE_INFINITY })
  presenter.hideProgress("h1")
  expect(mockToast.dismiss).toHaveBeenCalledWith("h1")
})

it("registers status bar slots while a plugin has entries", () => {
  const presenter = createVscodeWindowPresenter()
  presenter.syncStatusBar(["ext.a"])
  presenter.syncStatusBar(["ext.a"])
  expect(mockRegister.mock.calls.map((call) => call[0])).toEqual([
    "ext.a:statusbar.left",
    "ext.a:statusbar.right",
  ])
  const disposers = mockRegister.mock.results.map((result) => result.value as jest.Mock)
  presenter.syncStatusBar([])
  for (const dispose of disposers) expect(dispose).toHaveBeenCalled()
})

it("output notices are rate-limited per channel and open the plugin's logs", () => {
  let time = 0
  const presenter = createVscodeWindowPresenter({ now: () => time })
  presenter.outputShown("ext.a", "Server")
  presenter.outputShown("ext.a", "Server")
  presenter.outputShown("ext.a", "Client")
  expect(mockToast.custom).toHaveBeenCalledTimes(2)
  time = OUTPUT_NOTICE_INTERVAL_MS
  presenter.outputShown("ext.a", "Server")
  expect(mockToast.custom).toHaveBeenCalledTimes(3)

  const render = mockToast.custom.mock.calls[0][0]
  const element = render("t") as { props: { onOpenLogs: () => void } }
  element.props.onOpenLogs()
  expect(mockNavigate).toHaveBeenCalledWith("ext.a", expect.stringContaining("q=ext.a"))
  expect(mockToast.dismiss).toHaveBeenCalledWith("t")
})

it("file dialogs go to the native dialogs", async () => {
  await expect(createVscodeWindowPresenter().pickOpen({})).resolves.toEqual(["file:///x"])
})
