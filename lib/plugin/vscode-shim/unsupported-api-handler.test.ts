type Handler = (payload: unknown, context: { pluginId: string }) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockLog = jest.fn()
jest.mock("./vscode-log-buffer", () => ({
  appendVscodeLog: (...args: unknown[]) => mockLog(...args),
}))

import { VSCODE_API_COVERAGE } from "./engine-compat"
import { installVscodeUnsupportedApiHandler } from "./unsupported-api-handler"

describe("vscode:unsupportedApi", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    mockLog.mockClear()
    dispose = installVscodeUnsupportedApiHandler()
  })
  afterEach(() => dispose.forEach((fn) => fn()))

  const call = (payload: unknown, pluginId = "cognia.tree") =>
    handlers.get("vscode:unsupportedApi")!(payload, { pluginId })

  it("writes the reported API's reason to the extension's log", () => {
    expect(call({ extensionId: "cognia.tree", api: "window.registerTreeDataProvider" })).toBeNull()
    expect(mockLog).toHaveBeenCalledWith("cognia.tree", {
      level: "warn",
      kind: "unsupported-api",
      message: `vscode.window.registerTreeDataProvider is not supported in Cognia: ${VSCODE_API_COVERAGE.unsupported["window.registerTreeDataProvider"]}`,
    })
  })

  it("takes a namespace's reason for its members", () => {
    call({ api: "debug.startDebugging" })
    expect(mockLog.mock.calls[0][1].message).toBe(
      `vscode.debug.startDebugging is not supported in Cognia: ${VSCODE_API_COVERAGE.unsupported.debug}`
    )
  })

  it("still logs API the report has no reason for", () => {
    call({ api: "window.somethingNew" })
    expect(mockLog.mock.calls[0][1].message).toBe(
      "vscode.window.somethingNew is not supported in Cognia."
    )
  })

  it("refuses another extension's report and malformed payloads", () => {
    expect(() => call({ extensionId: "cognia.other", api: "workspace.saveAs" })).toThrow(
      /ownership mismatch/
    )
    expect(() => call({ api: "" })).toThrow(/non-empty api/)
    expect(() => call(null)).toThrow(/must be an object/)
    expect(mockLog).not.toHaveBeenCalled()
  })
})
