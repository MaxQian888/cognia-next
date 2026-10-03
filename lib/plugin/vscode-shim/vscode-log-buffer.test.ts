import {
  appendVscodeLog,
  clearVscodeLogs,
  getVscodeLogs,
  stderrLevel,
  subscribeVscodeLogEntries,
  subscribeVscodeLogs,
  VSCODE_LOG_LIMIT,
} from "./vscode-log-buffer"

beforeEach(() => {
  clearVscodeLogs("acme")
  jest.clearAllMocks()
})

it("keeps a bounded ring per extension, forwards each entry, and tells subscribers", () => {
  const changed = jest.fn()
  const written = jest.fn()
  const off = subscribeVscodeLogs(changed)
  const offEntries = subscribeVscodeLogEntries(written)
  appendVscodeLog("acme", { level: "info", message: "hello", kind: "stderr" })
  expect(getVscodeLogs("acme")).toEqual([
    expect.objectContaining({
      pluginId: "acme",
      runtime: "vscode",
      message: "hello",
      kind: "stderr",
    }),
  ])
  expect(written).toHaveBeenCalledWith(expect.objectContaining({ message: "hello" }))
  expect(changed).toHaveBeenCalledWith("acme")
  for (let i = 0; i < VSCODE_LOG_LIMIT + 5; i += 1) {
    appendVscodeLog("acme", { level: "debug", message: `line ${i}`, kind: "stderr" })
  }
  const logs = getVscodeLogs("acme")
  expect(logs).toHaveLength(VSCODE_LOG_LIMIT)
  expect(logs.at(-1)?.message).toBe(`line ${VSCODE_LOG_LIMIT + 4}`)
  expect(getVscodeLogs("other")).toEqual([])
  off()
  offEntries()
})

it("reads a stderr line's level from its prefix", () => {
  expect(stderrLevel("[lsp-service] ERROR boom")).toBe("error")
  expect(stderrLevel("Uncaught TypeError")).toBe("error")
  expect(stderrLevel("Error: boom")).toBe("error")
  expect(stderrLevel("    at x (file.js:1) TypeError: y")).toBe("error")
  expect(stderrLevel("no errors found")).toBe("info")
  expect(stderrLevel("[lsp-service] WARN slow")).toBe("warn")
  expect(stderrLevel("plain output")).toBe("info")
})
