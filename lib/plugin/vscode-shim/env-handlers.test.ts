/**
 * @jest-environment jsdom
 */

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

const mockLog = jest.fn()
jest.mock("./vscode-log-buffer", () => ({
  appendVscodeLog: (...args: unknown[]) => mockLog(...args),
}))

const mockPermissions = jest.fn(async (_pluginId: string) => ["clipboard:read"])
jest.mock("@/lib/plugin/core/transport", () => ({
  listPluginPermissions: (pluginId: string) => mockPermissions(pluginId),
}))

const mockClipboard = {
  read: jest.fn(async (): Promise<string | null> => "copied"),
  write: jest.fn(async (_text: string) => {}),
}
jest.mock("@/lib/tauri/clipboard", () => ({
  readClipboardText: () => mockClipboard.read(),
  writeClipboardText: (text: string) => mockClipboard.write(text),
}))
const mockOpener = {
  url: jest.fn(async (_url: string) => {}),
  path: jest.fn(async (_path: string) => {}),
}
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (url: string) => mockOpener.url(url),
  openPath: (path: string) => mockOpener.path(path),
}))
const mockRoute = jest.fn(async (_link: string) => true)
jest.mock("@/lib/plugin/uri/route-deep-link", () => ({
  routePluginDeepLink: (link: string) => mockRoute(link),
}))
let mockTauri = true
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => mockTauri }))

import { parseDeepLink } from "@/lib/plugin/uri/parse-deep-link"
import { __resetUriHandlersForTesting, dispatchUri } from "@/lib/plugin/uri/uri-handler-registry"

import {
  __resetVscodeEnvForTesting,
  clearVscodeEnvForPlugin,
  configureVscodeEnv,
  createVscodeEnvDependencies,
  installVscodeEnvHandlers,
  toExtensionUri,
  toPluginDeepLink,
  type OpenExternalChoice,
} from "./env-handlers"

function setup(options: { granted?: string[]; choice?: OpenExternalChoice } = {}) {
  mockPermissions.mockImplementation(async () => options.granted ?? [])
  const sent: Array<[string, string, unknown]> = []
  const confirm = jest.fn(async (_pluginId: string, _url: string) => options.choice ?? null)
  const deps = createVscodeEnvDependencies({
    confirmOpenExternal: confirm,
    sendToHost: async (pluginId, method, payload) => {
      sent.push([pluginId, method, payload])
      return { ok: true }
    },
  })
  configureVscodeEnv(deps)
  const call = async (method: string, payload: Record<string, unknown>, pluginId = "acme.ext") =>
    handlers.get(method)!(
      { extensionId: pluginId, ...payload },
      {
        pluginId,
        method,
        requestId: null,
      }
    )
  return { sent, confirm, call }
}

beforeEach(() => {
  handlers.clear()
  jest.clearAllMocks()
  mockTauri = true
  __resetVscodeEnvForTesting()
  __resetUriHandlersForTesting()
  installVscodeEnvHandlers()
})

describe("clipboard", () => {
  it("reads and writes with the matching permission, and reads an unreadable clipboard as empty", async () => {
    const { call } = setup({ granted: ["clipboard:read", "clipboard:write"] })
    await expect(call("env:clipboardReadText", {})).resolves.toBe("copied")
    await expect(call("env:clipboardWriteText", { text: "x" })).resolves.toBeNull()
    expect(mockClipboard.write).toHaveBeenCalledWith("x")
    mockClipboard.read.mockResolvedValueOnce(null)
    await expect(call("env:clipboardReadText", {})).resolves.toBe("")
  })

  it("refuses without the permission, and refuses another extension's request", async () => {
    const { call } = setup({ granted: ["clipboard:read"] })
    await expect(call("env:clipboardWriteText", { text: "x" })).rejects.toThrow(
      /requires permission clipboard:write/
    )
    setup({ granted: [] })
    await expect(call("env:clipboardReadText", {})).rejects.toThrow(/clipboard:read/)
    expect(mockClipboard.read).not.toHaveBeenCalled()
    await expect(
      Promise.resolve(
        handlers.get("env:clipboardReadText")!(
          { extensionId: "other.ext" },
          { pluginId: "acme.ext", method: "env:clipboardReadText", requestId: null }
        )
      )
    ).rejects.toThrow(/ownership mismatch/)
  })
})

describe("openExternal", () => {
  it("opens a web link once the user agrees, copies it when they ask, and does nothing otherwise", async () => {
    const opened = setup({ choice: "open" })
    await expect(
      opened.call("env:openExternal", { target: "https://example.com/a?b=1" })
    ).resolves.toBe(true)
    expect(opened.confirm).toHaveBeenCalledWith("acme.ext", "https://example.com/a?b=1")
    expect(mockOpener.url).toHaveBeenCalledWith("https://example.com/a?b=1")

    const copied = setup({ choice: "copy" })
    await expect(copied.call("env:openExternal", { target: "mailto:a@b.c" })).resolves.toBe(false)
    expect(mockClipboard.write).toHaveBeenCalledWith("mailto:a@b.c")

    const declined = setup({ choice: null })
    await expect(declined.call("env:openExternal", { target: "http://x.test" })).resolves.toBe(
      false
    )
    expect(mockOpener.url).toHaveBeenCalledTimes(1)
  })

  it("sends an app link to the extension it names without asking", async () => {
    const { call, confirm } = setup()
    await expect(
      call("env:openExternal", { target: "cognia://other.ext/cb?code=1#top" })
    ).resolves.toBe(true)
    expect(mockRoute).toHaveBeenCalledWith("cognia://plugin/other.ext/cb?code=1#top")
    expect(confirm).not.toHaveBeenCalled()
    mockRoute.mockResolvedValueOnce(false)
    await expect(call("env:openExternal", { target: "cognia://gone.ext/" })).resolves.toBe(false)
    expect(mockLog).toHaveBeenCalledWith(
      "acme.ext",
      expect.objectContaining({ level: "warn", message: "No extension handles cognia://gone.ext/" })
    )
  })

  it("opens a file only for an extension that may run programs", async () => {
    const denied = setup({ granted: [] })
    await expect(
      denied.call("env:openExternal", { target: "file:///tmp/a%20b.txt" })
    ).rejects.toThrow(/shell:execute/)
    const allowed = setup({ granted: ["shell:execute"] })
    await expect(
      allowed.call("env:openExternal", { target: "file:///tmp/a%20b.txt" })
    ).resolves.toBe(true)
    expect(mockOpener.path).toHaveBeenCalledWith("/tmp/a b.txt")
  })

  it("refuses other schemes and logs why", async () => {
    const { call } = setup()
    await expect(call("env:openExternal", { target: "ftp://x/y" })).resolves.toBe(false)
    expect(mockLog).toHaveBeenCalledWith(
      "acme.ext",
      expect.objectContaining({ message: "openExternal does not open ftp links: ftp://x/y" })
    )
    await expect(call("env:openExternal", { target: "" })).rejects.toThrow(/non-empty target/)
  })
})

describe("asExternalUri", () => {
  it("keeps web links and turns app links into the deep link the system routes back", async () => {
    const { call } = setup()
    await expect(call("env:asExternalUri", { target: "http://localhost:3000/x" })).resolves.toBe(
      "http://localhost:3000/x"
    )
    await expect(call("env:asExternalUri", { target: "cognia://acme.ext/auth" })).resolves.toBe(
      "cognia://plugin/acme.ext/auth"
    )
    mockTauri = false
    await expect(call("env:asExternalUri", { target: "cognia://acme.ext/auth?x=1" })).resolves.toBe(
      `${window.location.origin}/deep-link?u=${encodeURIComponent("cognia://plugin/acme.ext/auth?x=1")}`
    )
  })

  it("refuses other schemes and app links without an extension", async () => {
    const { call } = setup()
    await expect(call("env:asExternalUri", { target: "file:///x" })).rejects.toThrow(
      /http, https and cognia URIs, not file ones/
    )
    await expect(call("env:asExternalUri", { target: "cognia:///x" })).rejects.toThrow(
      /names no extension/
    )
  })
})

describe("URI handler", () => {
  it("hands the extension its deep links in VS Code's shape, until it unregisters", async () => {
    const { call, sent } = setup()
    await call("window:registerUriHandler", { token: "uri:acme.ext" })
    expect(dispatchUri(parseDeepLink("cognia://plugin/acme.ext/done?code=1&state=2#f")!)).toBe(true)
    await Promise.resolve()
    expect(sent).toEqual([
      [
        "acme.ext",
        "extension:call",
        {
          extensionId: "acme.ext",
          token: "uri:acme.ext",
          method: "handleUri",
          payload: "cognia://acme.ext/done?code=1&state=2#f",
        },
      ],
    ])
    await call("window:unregisterUriHandler", {})
    expect(dispatchUri(parseDeepLink("cognia://plugin/acme.ext/again")!)).toBe(false)
  })

  it("replaces an earlier registration and drops the handler when the extension stops", async () => {
    const { call, sent } = setup()
    await call("window:registerUriHandler", { token: "first" })
    await call("window:registerUriHandler", { token: "second" })
    dispatchUri(parseDeepLink("cognia://plugin/acme.ext/x")!)
    await Promise.resolve()
    expect(sent.map(([, , payload]) => (payload as { token: string }).token)).toEqual(["second"])
    clearVscodeEnvForPlugin("acme.ext")
    expect(dispatchUri(parseDeepLink("cognia://plugin/acme.ext/x")!)).toBe(false)
    await expect(call("window:registerUriHandler", {})).rejects.toThrow(/non-empty token/)
  })
})

describe("link shapes", () => {
  it("maps app links to plugin deep links and back", () => {
    expect(toPluginDeepLink("cognia://acme.ext")).toBe("cognia://plugin/acme.ext")
    expect(toPluginDeepLink("cognia://plugin/acme.ext/x")).toBe("cognia://plugin/acme.ext/x")
    expect(toPluginDeepLink("web+cognia://plugin/acme.ext/x")).toBe("cognia://plugin/acme.ext/x")
    expect(toExtensionUri(parseDeepLink("web+cognia://plugin/acme.ext?x=1")!)).toBe(
      "cognia://acme.ext?x=1"
    )
    expect(toExtensionUri(parseDeepLink("cognia://plugin/acme.ext")!)).toBe("cognia://acme.ext")
  })
})

it("fails plainly before the loader configures it", async () => {
  await expect(
    (async () =>
      handlers.get("env:asExternalUri")!(
        { target: "cognia://a.b/" },
        { pluginId: "a.b", method: "env:asExternalUri", requestId: null }
      ))()
  ).rejects.toThrow(/not available yet/)
})
