/**
 * Deliberately neither jsdom nor `fake-indexeddb/auto`. Every database and
 * browser touchpoint here is mocked, so both would only buy a much larger
 * module graph to transform on every run.
 */
const routeEngine = jest.fn((_url: string, _ctx?: unknown): unknown => {
  throw new Error("Remote browser is not enabled or healthy")
})
jest.mock("@/lib/browser/agent-engine", () => ({
  routeEngine: (url: string, ctx?: unknown) => routeEngine(url, ctx),
}))

const hasEmbedOwner = jest.fn(() => false)
jest.mock("@/lib/browser/client", () => ({
  browserClient: { hasEmbedOwner: () => hasEmbedOwner() },
}))

const isBrowserDomainAuthorized = jest.fn((_url: string) => true)
const primeBrowserDomainGrants = jest.fn(async () => [] as string[])
jest.mock("@/lib/browser/domain-authorization", () => ({
  isBrowserDomainAuthorized: (url: string) => isBrowserDomainAuthorized(url),
  primeBrowserDomainGrants: () => primeBrowserDomainGrants(),
}))

const call = jest.fn(async (_c: string, _a?: unknown): Promise<unknown> => null)
jest.mock("@/lib/tauri", () => ({ transport: { call: (c: string, a?: unknown) => call(c, a) } }))

// The instance the broker keeps IS the engine it drives, so the double has to
// carry the methods rather than merely record that one was constructed.
const remoteEngineInstances: Array<ReturnType<typeof makeEngine>> = []
jest.mock("@/lib/browser/remote-chromium-engine", () => ({
  RemoteChromiumEngine: function RemoteChromiumEngineDouble(
    this: Record<string, unknown>,
    id: string
  ) {
    const engine = makeEngine()
    remoteEngineInstances.push(engine)
    Object.assign(this, engine, { browserSessionId: id })
  } as unknown as new (id: string) => unknown,
}))

const replayFlow = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, steps: [] }))
jest.mock("@/lib/browser/recording/replayer", () => ({
  replayFlow: (...a: unknown[]) => replayFlow(...a),
}))

const getRecording = jest.fn(async (_id: string): Promise<unknown> => undefined)
jest.mock("@/lib/db/browser-recordings", () => ({ getRecording: (id: string) => getRecording(id) }))

jest.mock("@/lib/db/browser-profiles", () => ({ listBrowserDomainGrants: async () => [] }))

/** Where the doubles report they landed. Set per test when it matters. */
let defaultLandedUrl = "https://example.com/"

function makeEngine() {
  return {
    navigate: jest.fn(async () => undefined),
    waitForLoad: jest.fn(async () => ({ ok: true, timedOut: false })),
    getPage: jest.fn(async () => ({ url: defaultLandedUrl, title: "Example" })),
    snapshot: jest.fn(
      async (): Promise<{
        generation: number
        url: string
        title: string
        nodes: Array<Record<string, unknown>>
      }> => ({ generation: 1, url: "https://example.com/", title: "Example", nodes: [] })
    ),
    act: jest.fn(
      async (
        _ref?: string,
        _action?: string,
        _args?: unknown
      ): Promise<{ ok: boolean; error: string | null; generation: number }> => ({
        ok: true,
        error: null,
        generation: 2,
      })
    ),
    pressKey: jest.fn(async () => ({ ok: true, error: null, generation: 2 })),
    scroll: jest.fn(async () => ({ ok: true, error: null, generation: 2 })),
    waitForText: jest.fn(async () => ({ ok: true, timedOut: false })),
    waitForSelector: jest.fn(async () => ({ ok: true, timedOut: false })),
    waitForNetworkIdle: jest.fn(async () => ({ ok: true, timedOut: false })),
    screenshot: jest.fn(async () => ({ bytes: "AAAA", width: 800, height: 600 })),
    readConsole: jest.fn(async () => []),
    readNetwork: jest.fn(async () => []),
  }
}

import "."
import { getExecutor } from "../registry"
import { __resetBrowserEnginePrimingForTesting } from "./engine"
import { __resetRunBrowserSessionsForTesting } from "./session-registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

let runCounter = 0

function run(kind: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const executor = getExecutor(kind as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: `run${++runCounter}`,
    stepId: "s1",
    projectId: "proj1",
    signal: new AbortController().signal,
    credentialRefs: {},
    resolveSecret: async () => undefined,
    log: () => undefined,
    ...extra,
  } as unknown as StepExecutionContext)
}

/** The engine the broker minted for the most recent run. */
function lastRemoteEngine() {
  return remoteEngineInstances[remoteEngineInstances.length - 1]
}

beforeEach(() => {
  jest.clearAllMocks()
  remoteEngineInstances.length = 0
  __resetBrowserEnginePrimingForTesting()
  __resetRunBrowserSessionsForTesting()
  defaultLandedUrl = "https://example.com/"
  hasEmbedOwner.mockReturnValue(false)
  isBrowserDomainAuthorized.mockReturnValue(true)
  routeEngine.mockImplementation(() => {
    throw new Error("Remote browser is not enabled or healthy")
  })
  call.mockImplementation(async (command: string) => {
    if (command === "browser_runtime_status")
      return { compiled: true, healthy: true, enabled: true }
    if (command === "browser_capability") return { capabilities: ["browser"] }
    if (command === "browser_session_ensure") return { id: "bs1" }
    return null
  })
})

describe("registration", () => {
  it.each([
    "action.browser.open",
    "action.browser.snapshot",
    "action.browser.readPage",
    "action.browser.act",
    "action.browser.fillForm",
    "action.browser.waitFor",
    "action.browser.screenshot",
    "action.browser.diagnostics",
    "action.browser.replayFlow",
  ])("registers %s", (kind) => {
    expect(getExecutor(kind as never, 1)).toBeDefined()
  })

  it("registers no evaluate node", () => {
    // Arbitrary JS on a public page in a run with nobody watching is the
    // computer-use surface with its gate removed.
    expect(getExecutor("action.browser.evaluate" as never, 1)).toBeUndefined()
  })

  it.each(["action.browser.act", "action.browser.fillForm", "action.browser.replayFlow"])(
    "%s does not retry, because a retry re-clicks a real page",
    (kind) => {
      expect(getExecutor(kind as never, 1)!.retryable).toBe(false)
    }
  )
})

describe("domain authorization", () => {
  it("refuses an ungranted public URL and never touches an engine", async () => {
    isBrowserDomainAuthorized.mockReturnValue(false)
    await expect(run("action.browser.open", { url: "https://evil.test/x" })).rejects.toThrow(
      /evil\.test is not an authorized browsing domain/
    )
    expect(routeEngine).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it("never falls back to the local pane the way routeEngine would", async () => {
    isBrowserDomainAuthorized.mockReturnValue(false)
    hasEmbedOwner.mockReturnValue(true)
    await expect(run("action.browser.open", { url: "https://evil.test/x" })).rejects.toThrow(
      /never prompts and never falls back/
    )
  })

  it("allows loopback without a grant", async () => {
    isBrowserDomainAuthorized.mockReturnValue(false)
    // The default double lands on example.com, which the landed-url re-check
    // would then refuse. Land on the loopback origin the node was pointed at.
    defaultLandedUrl = "http://localhost:3000/"
    await run("action.browser.open", { url: "http://localhost:3000/" })
    expect(call).toHaveBeenCalledWith("browser_session_ensure", expect.anything())
  })

  it("primes the Dexie grant snapshot before routing, once per run", async () => {
    await run("action.browser.open", { url: "http://localhost:3000/" })
    expect(primeBrowserDomainGrants).toHaveBeenCalledTimes(1)
  })
})

describe("engine selection", () => {
  it("reuses the pane only when it genuinely holds the owner lease", async () => {
    const paneEngine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine: paneEngine, backend: "embedded", tier: "trusted" })

    const out = (await run("action.browser.open", { url: "http://localhost:3000/" }))
      .output as Record<string, unknown>
    expect(out.backend).toBe("embedded")
    expect(paneEngine.navigate).toHaveBeenCalledWith("http://localhost:3000/")
    // No remote session minted when the pane is right there.
    expect(call).not.toHaveBeenCalledWith("browser_session_ensure", expect.anything())
  })

  it("does not borrow the pane's engine when the lease is gone", async () => {
    const paneEngine = makeEngine()
    hasEmbedOwner.mockReturnValue(false)
    routeEngine.mockReturnValue({ engine: paneEngine, backend: "embedded", tier: "trusted" })

    await run("action.browser.open", { url: "http://localhost:3000/" })
    expect(paneEngine.navigate).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith("browser_session_ensure", expect.anything())
    expect(lastRemoteEngine().navigate).toHaveBeenCalledWith("http://localhost:3000/")
  })

  it("never takes over the page bound to a conversation", async () => {
    // ADR-0085 binds one BrowserSession to one parent chat session. A
    // background run stealing it is the same defect as stealing focus.
    const paneRemote = makeEngine()
    routeEngine.mockReturnValue({
      engine: paneRemote,
      backend: "remote-chromium",
      tier: "public",
    })
    await run("action.browser.open", { url: "https://example.com/" })
    expect(paneRemote.navigate).not.toHaveBeenCalled()
    expect(lastRemoteEngine().navigate).toHaveBeenCalledWith("https://example.com/")
    expect(call.mock.calls.find((c) => c[0] === "browser_session_ensure")?.[1]).toMatchObject({
      chatSessionId: expect.stringContaining("workflow:"),
    })
  })

  it("explains an uncompiled runtime instead of a bare error code", async () => {
    call.mockImplementation(async (command: string) =>
      command === "browser_runtime_status" ? { compiled: false } : null
    )
    await expect(run("action.browser.open", { url: "http://localhost/" })).rejects.toThrow(
      /this build has no remote browser runtime/
    )
  })

  it("explains a runtime switched off for the workspace", async () => {
    call.mockImplementation(async (command: string) => {
      if (command === "browser_runtime_status") return { compiled: true, healthy: true }
      if (command === "browser_capability") return { capabilities: [] }
      return null
    })
    await expect(run("action.browser.open", { url: "http://localhost/" })).rejects.toThrow(
      /remote browser is switched off for this workspace/
    )
  })
})

describe("action.browser.open", () => {
  it("re-checks authorization on the landed url, not the requested one", async () => {
    // A redirect off the granted domain must fail rather than licensing
    // whatever the page became.
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "public" })
    engine.getPage.mockResolvedValue({ url: "https://elsewhere.test/", title: "Elsewhere" })
    isBrowserDomainAuthorized.mockImplementation((url: string) => url.includes("example.com"))

    await expect(run("action.browser.open", { url: "https://example.com/" })).rejects.toThrow(
      /elsewhere\.test is not an authorized browsing domain/
    )
    expect(engine.navigate).toHaveBeenCalled()
  })

  it("reports a redirect that stayed inside the grant", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "public" })
    engine.getPage.mockResolvedValue({ url: "https://example.com/landed", title: "Landed" })
    const out = (await run("action.browser.open", { url: "https://example.com/" }))
      .output as Record<string, unknown>
    expect(out).toMatchObject({ url: "https://example.com/landed", redirected: true })
  })

  it("requires a url", async () => {
    await expect(run("action.browser.open", {})).rejects.toThrow(/requires 'url'/)
  })
})

describe("action.browser.snapshot", () => {
  it("caps the node list and says the tree was bigger", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    engine.snapshot.mockResolvedValue({
      generation: 3,
      url: "https://example.com/",
      title: "T",
      nodes: Array.from({ length: 500 }, (_, i) => ({ ref: `r${i}`, name: `n${i}`, value: null })),
    })
    const out = (await run("action.browser.snapshot", { maxNodes: 10 })).output as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({ nodeCount: 10, totalNodeCount: 500, truncated: true })
  })
})

describe("action.browser.act", () => {
  it("routes a key chord through pressKey and a scroll through scroll", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })

    await run("action.browser.act", { action: "key", value: "Enter" })
    expect(engine.pressKey).toHaveBeenCalledWith("Enter", undefined)

    await run("action.browser.act", { action: "scroll", direction: "down", amount: 3 })
    expect(engine.scroll).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "down", amount: 3 })
    )
  })

  it("requires a ref for an element action, and rejects an unknown action", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    await expect(run("action.browser.act", { action: "click" })).rejects.toThrow(/requires 'ref'/)
    await expect(run("action.browser.act", { action: "teleport" })).rejects.toThrow(
      /'action' must be one of/
    )
  })
})

describe("action.browser.fillForm", () => {
  it("fails loudly on a credential it cannot resolve", async () => {
    // Typing an empty string into a password box looks like it worked.
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    await expect(
      run(
        "action.browser.fillForm",
        { fields: [{ ref: "r1", credentialRef: "missing" }] },
        { resolveSecret: async () => undefined }
      )
    ).rejects.toThrow(/names credential 'missing', which this run cannot resolve/)
    expect(engine.act).not.toHaveBeenCalled()
  })

  it("uses the resolved secret and never the literal", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    await run(
      "action.browser.fillForm",
      { fields: [{ ref: "r1", value: "placeholder", credentialRef: "pw" }] },
      { resolveSecret: async () => "s3cret" }
    )
    expect(engine.act).toHaveBeenCalledWith("r1", "fill", { value: "s3cret" })
  })

  it("reports where it stopped rather than claiming a known form state", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    engine.act
      .mockResolvedValueOnce({ ok: true, error: null, generation: 1 })
      .mockResolvedValueOnce({ ok: false, error: "no such element", generation: 1 })
    const out = (
      await run("action.browser.fillForm", {
        fields: [
          { ref: "a", value: "1" },
          { ref: "b", value: "2" },
          { ref: "c", value: "3" },
        ],
      })
    ).output as Record<string, unknown>
    expect(out).toMatchObject({ ok: false, failedIndex: 1, failedRef: "b", completedCount: 1 })
    expect(engine.act).toHaveBeenCalledTimes(2)
  })
})

describe("action.browser.waitFor", () => {
  it("takes exactly one condition", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    await expect(run("action.browser.waitFor", {})).rejects.toThrow(/exactly one of/)
    await expect(run("action.browser.waitFor", { text: "hi", selector: ".x" })).rejects.toThrow(
      /exactly one of/
    )
  })

  it("fails on a timeout unless the author opted out", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    engine.waitForText.mockResolvedValue({ ok: false, timedOut: true })
    await expect(run("action.browser.waitFor", { text: "later" })).rejects.toThrow(
      /was not met within the timeout/
    )
    const out = (await run("action.browser.waitFor", { text: "later", failOnTimeout: false }))
      .output as Record<string, unknown>
    expect(out).toMatchObject({ met: false })
  })
})

describe("action.browser.screenshot", () => {
  it("reports the size but withholds the bytes by default", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    const out = (await run("action.browser.screenshot", {})).output as Record<string, unknown>
    expect(out).toMatchObject({ byteLength: 4, width: 800, height: 600 })
    expect(out.imageBase64).toBeUndefined()

    const withImage = (await run("action.browser.screenshot", { includeImage: true }))
      .output as Record<string, unknown>
    expect(withImage.imageBase64).toBe("AAAA")
  })

  it("requires a ref for an element scope", async () => {
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    await expect(run("action.browser.screenshot", { scope: "element" })).rejects.toThrow(
      /element scope requires 'ref'/
    )
  })
})

describe("action.browser.replayFlow", () => {
  it("checks the base origin and every navigate step against current grants", async () => {
    // A recording is a script someone saved earlier, and the grants may have
    // narrowed since.
    getRecording.mockResolvedValue({
      id: "rec1",
      name: "Login",
      baseUrl: "https://example.com/",
      steps: [{ act: "navigate", url: "https://elsewhere.test/" }],
      createdAt: 1,
      updatedAt: 1,
    })
    isBrowserDomainAuthorized.mockImplementation((url: string) => url.includes("example.com"))
    await expect(run("action.browser.replayFlow", { recordingId: "rec1" })).rejects.toThrow(
      /elsewhere\.test is not an authorized browsing domain/
    )
    expect(replayFlow).not.toHaveBeenCalled()
  })

  it("reports which step failed", async () => {
    getRecording.mockResolvedValue({
      id: "rec1",
      name: "Login",
      baseUrl: "http://localhost:3000/",
      steps: [],
      createdAt: 1,
      updatedAt: 1,
    })
    const engine = makeEngine()
    hasEmbedOwner.mockReturnValue(true)
    routeEngine.mockReturnValue({ engine, backend: "embedded", tier: "trusted" })
    replayFlow.mockResolvedValue({
      ok: false,
      steps: [
        { index: 0, step: {}, ok: true, error: null },
        { index: 1, step: {}, ok: false, error: "element gone" },
      ],
    })
    const out = (await run("action.browser.replayFlow", { recordingId: "rec1" })).output as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({
      ok: false,
      stepCount: 2,
      completedCount: 1,
      failedStepIndex: 1,
      error: "element gone",
    })
  })

  it("refuses a recording that is not there", async () => {
    getRecording.mockResolvedValue(undefined)
    await expect(run("action.browser.replayFlow", { recordingId: "gone" })).rejects.toThrow(
      /no recording gone/
    )
  })
})
