/**
 * The broker's own decisions, separate from the nodes that use it.
 */
const routeEngine = jest.fn((_u: string, _c?: unknown): unknown => {
  throw new Error("Remote browser is not enabled or healthy")
})
jest.mock("@/lib/browser/agent-engine", () => ({
  routeEngine: (u: string, c?: unknown) => routeEngine(u, c),
}))

const hasEmbedOwner = jest.fn(() => false)
jest.mock("@/lib/browser/client", () => ({
  browserClient: { hasEmbedOwner: () => hasEmbedOwner() },
}))

const isBrowserDomainAuthorized = jest.fn((_u: string) => true)
const primeBrowserDomainGrants = jest.fn(async () => [] as string[])
jest.mock("@/lib/browser/domain-authorization", () => ({
  isBrowserDomainAuthorized: (u: string) => isBrowserDomainAuthorized(u),
  primeBrowserDomainGrants: () => primeBrowserDomainGrants(),
}))

const call = jest.fn(async (_c: string, _a?: unknown): Promise<unknown> => null)
jest.mock("@/lib/tauri", () => ({ transport: { call: (c: string, a?: unknown) => call(c, a) } }))

jest.mock("@/lib/browser/remote-chromium-engine", () => ({
  RemoteChromiumEngine: function Double(this: Record<string, unknown>, id: string) {
    this.browserSessionId = id
  } as unknown as new (id: string) => unknown,
}))

const listBrowserDomainGrants = jest.fn(async (_w: string): Promise<unknown[]> => [
  { domain: "example.com" },
])
jest.mock("@/lib/db/browser-profiles", () => ({
  listBrowserDomainGrants: (w: string) => listBrowserDomainGrants(w),
}))

import {
  __resetBrowserEnginePrimingForTesting,
  assertBrowserUrlAllowed,
  resolveRunBrowserEngine,
} from "./engine"
import { __resetRunBrowserSessionsForTesting, getRunBrowserSession } from "./session-registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function ctx(runId = "run1"): StepExecutionContext {
  return { runId, projectId: "proj1" } as unknown as StepExecutionContext
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetBrowserEnginePrimingForTesting()
  __resetRunBrowserSessionsForTesting()
  hasEmbedOwner.mockReturnValue(false)
  isBrowserDomainAuthorized.mockReturnValue(true)
  routeEngine.mockImplementation(() => {
    throw new Error("Remote browser is not enabled or healthy")
  })
  call.mockImplementation(async (command: string) => {
    if (command === "browser_runtime_status") return { compiled: true, healthy: true }
    if (command === "browser_capability") return { capabilities: ["browser"] }
    if (command === "browser_session_ensure") return { id: "bs1" }
    return null
  })
})

describe("assertBrowserUrlAllowed", () => {
  it("lets loopback through without consulting the grants", () => {
    isBrowserDomainAuthorized.mockReturnValue(false)
    expect(assertBrowserUrlAllowed("http://localhost:3000/x", "k")).toBe("trusted")
    expect(isBrowserDomainAuthorized).not.toHaveBeenCalled()
  })

  it("names the host and the way out for an ungranted public url", () => {
    isBrowserDomainAuthorized.mockReturnValue(false)
    expect(() => assertBrowserUrlAllowed("https://evil.test/a?b=1", "k")).toThrow(
      /evil\.test is not an authorized browsing domain/
    )
  })

  it("shows a malformed url verbatim rather than a parse error", () => {
    isBrowserDomainAuthorized.mockReturnValue(false)
    expect(() => assertBrowserUrlAllowed("://nonsense", "k")).toThrow(/:\/\/nonsense/)
  })
})

describe("resolveRunBrowserEngine", () => {
  it("primes the grant snapshot once per run", async () => {
    await resolveRunBrowserEngine(ctx(), "http://localhost/", "k")
    await resolveRunBrowserEngine(ctx(), "http://localhost/", "k")
    expect(primeBrowserDomainGrants).toHaveBeenCalledTimes(1)

    await resolveRunBrowserEngine(ctx("run2"), "http://localhost/", "k")
    expect(primeBrowserDomainGrants).toHaveBeenCalledTimes(2)
  })

  it("reuses the run's session instead of minting a second one", async () => {
    await resolveRunBrowserEngine(ctx(), "http://localhost/", "k")
    call.mockClear()
    await resolveRunBrowserEngine(ctx(), "http://localhost/", "k")
    expect(call).not.toHaveBeenCalled()
    expect(getRunBrowserSession("run1")).toBeDefined()
  })

  it("namespaces the session by run, so it cannot collide with a conversation's", async () => {
    await resolveRunBrowserEngine(ctx(), "http://localhost/", "k")
    const args = call.mock.calls.find((c) => c[0] === "browser_session_ensure")?.[1] as Record<
      string,
      unknown
    >
    expect(args.chatSessionId).toBe("workflow:run1")
    expect(args.workspaceId).toBe("proj1")
    expect(args.domainGrants).toEqual(["example.com"])
  })

  it("survives a grant lookup that fails, rather than failing the step", async () => {
    listBrowserDomainGrants.mockRejectedValue(new Error("db gone"))
    await resolveRunBrowserEngine(ctx(), "http://localhost/", "k")
    const args = call.mock.calls.find((c) => c[0] === "browser_session_ensure")?.[1] as Record<
      string,
      unknown
    >
    expect(args.domainGrants).toEqual([])
  })

  it("denies rather than permits when priming the grants fails", async () => {
    // An empty snapshot means nothing is authorized, which is the safe
    // direction for a run with nobody watching.
    primeBrowserDomainGrants.mockRejectedValue(new Error("db gone"))
    isBrowserDomainAuthorized.mockReturnValue(false)
    await expect(resolveRunBrowserEngine(ctx(), "https://example.com/", "k")).rejects.toThrow(
      /not an authorized browsing domain/
    )
  })
})
