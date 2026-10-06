import { createProjectAPI } from "@/lib/plugin/api/project-api"
import {
  attachProjectWebviewRpc,
  acquireCogniaProjectApiSource,
  PROJECT_WEBVIEW_CHANNEL,
  PROJECT_WEBVIEW_METHODS,
} from "./project-webview-rpc"
import {
  __resetWebviewsForTesting,
  attachWebviewPoster,
  dispatchWebviewMessage,
} from "@/lib/plugin/registries/webview-registry"
import type { PluginProjectAPI } from "@/types/plugin/plugin"

jest.mock("@/lib/plugin/api/project-api", () => ({ createProjectAPI: jest.fn() }))

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const fullId = "reading-plugin:docs"
const scope = { kind: "project", projectId: "p" }
const request = (id: number, method: string, params: unknown[] = [{ scope }]) =>
  dispatchWebviewMessage(fullId, {
    data: { channel: PROJECT_WEBVIEW_CHANNEL, kind: "request", id, method, params },
  })

describe("sandboxed project document contract", () => {
  const api = Object.fromEntries(
    PROJECT_WEBVIEW_METHODS.map((method) => [method, jest.fn().mockResolvedValue({ method })])
  ) as unknown as PluginProjectAPI
  let output: Array<{ id: number; ok: boolean; error?: string; result?: unknown }>
  const disposers: Array<() => void> = []
  beforeEach(() => {
    __resetWebviewsForTesting()
    output = []
    Object.values(api).forEach((fn) => fn.mockReset().mockResolvedValue({ original: true }))
    jest.mocked(createProjectAPI).mockReturnValue(api)
    disposers.push(
      attachWebviewPoster(fullId, (message) => {
        output.push(message as (typeof output)[number])
        return true
      })
    )
  })
  afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose())
    __resetWebviewsForTesting()
  })

  it("executes every advertised method asynchronously against the existing host API", async () => {
    disposers.push(attachProjectWebviewRpc("reading-plugin", "docs", { hasPermission: () => true }))
    for (const [index, method] of PROJECT_WEBVIEW_METHODS.entries()) {
      request(index, method)
    }
    await settle()
    expect(output).toHaveLength(PROJECT_WEBVIEW_METHODS.length)
    expect(output.every((item) => item.ok && item.result)).toBe(true)
    PROJECT_WEBVIEW_METHODS.forEach((method) => expect(api[method]).toHaveBeenCalledWith({ scope }))
  })

  it("rechecks live read, write and KB permission independently on each request", async () => {
    const permissions = new Set(["project:read"])
    disposers.push(
      attachProjectWebviewRpc("reading-plugin", "docs", {
        hasPermission: (permission) => permissions.has(permission),
      })
    )
    request(1, "listKnowledgeDocuments")
    request(2, "addKnowledgeFile", ["p", { name: "a", content: "text" }])
    request(3, "readKnowledgeRange", [
      { scope: { kind: "agent", sessionId: "s" }, knowledgeBaseId: "kb", sourceId: "source" },
    ])
    await settle()
    expect(output.find((item) => item.id === 1)?.ok).toBe(true)
    expect(output.filter((item) => item.id !== 1).map((item) => item.error)).toEqual([
      "permission_denied",
      "permission_denied",
    ])
    permissions.clear()
    request(4, "listKnowledgeDocuments")
    await settle()
    expect(output.find((item) => item.id === 4)?.error).toBe("permission_denied")
    expect(api.listKnowledgeDocuments).toHaveBeenCalledTimes(1)
    expect(api.addKnowledgeFile).not.toHaveBeenCalled()
  })

  it("suppresses a result revoked while it awaited disk and blocks unlisted methods", async () => {
    let allowed = true
    let finish!: (value: unknown) => void
    jest.mocked(api.readKnowledgeRange).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = (value) =>
            resolve(value as Awaited<ReturnType<PluginProjectAPI["readKnowledgeRange"]>>)
        })
    )
    disposers.push(
      attachProjectWebviewRpc("reading-plugin", "docs", { hasPermission: () => allowed })
    )
    request(1, "readKnowledgeRange")
    request(2, "getKnowledgeFiles")
    request(3, "constructor")
    allowed = false
    finish({ text: "private original" })
    await settle()
    expect(output.find((item) => item.id === 1)?.error).toBe("permission_denied")
    expect(
      output
        .filter((item) => item.id !== 1)
        .every((item) => item.error === "invalid_project_request")
    ).toBe(true)
    expect(JSON.stringify(output)).not.toContain("private original")
  })

  it("refcounts attachments and prevents late responses after the last close", async () => {
    const first = attachProjectWebviewRpc("reading-plugin", "docs", { hasPermission: () => true })
    const second = attachProjectWebviewRpc("reading-plugin", "docs", { hasPermission: () => true })
    first()
    first()
    request(1, "listKnowledgeDocuments")
    await settle()
    expect(output).toHaveLength(1)
    let finish!: (value: unknown) => void
    jest.mocked(api.readKnowledgeRange).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = (value) =>
            resolve(value as Awaited<ReturnType<PluginProjectAPI["readKnowledgeRange"]>>)
        })
    )
    request(2, "readKnowledgeRange")
    second()
    finish({ text: "late" })
    await settle()
    request(3, "listKnowledgeDocuments")
    await settle()
    expect(output).toHaveLength(1)
  })

  it("bounds malicious concurrent requests and duplicate ids on the host", async () => {
    jest.mocked(api.readKnowledgeRange).mockImplementation(() => new Promise(() => {}))
    disposers.push(attachProjectWebviewRpc("reading-plugin", "docs", { hasPermission: () => true }))
    for (let id = 0; id < 34; id++) request(id, "readKnowledgeRange")
    request(0, "readKnowledgeRange")
    await settle()
    expect(api.readKnowledgeRange).toHaveBeenCalledTimes(32)
    expect(output).toHaveLength(3)
    expect(output.every((item) => item.error === "request_budget_exhausted")).toBe(true)
  })

  it("publishes the same allowlist in the iframe client with parent validation and close recovery", () => {
    const source = acquireCogniaProjectApiSource()
    PROJECT_WEBVIEW_METHODS.forEach((method) => expect(source).toContain(method))
    expect(source).toContain("can only be called once")
    expect(source).toContain("event.source !== window.parent")
    expect(source).toContain("pending.size >= 32")
    expect(source).toContain("webview_closed")
    expect(source).toContain("project_request_timeout")
    expect(source).not.toContain("getKnowledgeFiles")
  })
})
