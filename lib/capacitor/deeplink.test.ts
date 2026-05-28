/**
 * @jest-environment jsdom
 */
import { getLaunchRoute, parseDeeplink, subscribe } from "./deeplink"

describe("parseDeeplink", () => {
  it("parses oauth callback with code + state", () => {
    const route = parseDeeplink("cognia://oauth/claude?code=abc&state=xyz")
    expect(route).toEqual({
      kind: "oauth_callback",
      provider: "claude",
      code: "abc",
      state: "xyz",
      raw: "cognia://oauth/claude?code=abc&state=xyz",
    })
  })

  it("parses pair payload", () => {
    const route = parseDeeplink("cognia://pair?payload=BASE64DATA")
    expect(route).toEqual({
      kind: "pair_qr",
      payload: "BASE64DATA",
      raw: "cognia://pair?payload=BASE64DATA",
    })
  })

  it("parses session open", () => {
    const route = parseDeeplink("cognia://session/abc-123")
    expect(route).toEqual({
      kind: "open_session",
      sessionId: "abc-123",
      raw: "cognia://session/abc-123",
    })
  })

  it("parses share-target with text + url", () => {
    const route = parseDeeplink("cognia://share?text=hello&url=https%3A%2F%2Fexample.com")
    expect(route).toEqual({
      kind: "share_target",
      text: "hello",
      url: "https://example.com",
      raw: "cognia://share?text=hello&url=https%3A%2F%2Fexample.com",
    })
  })

  it("parses workflow-run open with workflowId + runId path", () => {
    const route = parseDeeplink("cognia://workflow-run/wf_abc/run_xyz")
    expect(route).toEqual({
      kind: "open_workflow_run",
      workflowId: "wf_abc",
      runId: "run_xyz",
      raw: "cognia://workflow-run/wf_abc/run_xyz",
    })
  })

  it("falls back to query params when workflow-run path is missing one id", () => {
    const route = parseDeeplink("cognia://workflow-run?workflowId=wf_abc&runId=run_xyz")
    expect(route).toMatchObject({
      kind: "open_workflow_run",
      workflowId: "wf_abc",
      runId: "run_xyz",
    })
  })

  it("unknown for unrelated scheme", () => {
    const route = parseDeeplink("https://example.com/foo")
    expect(route.kind).toBe("unknown")
  })

  it("unknown for unparseable url", () => {
    const route = parseDeeplink("not a url")
    expect(route.kind).toBe("unknown")
  })
})

describe("subscribe", () => {
  it("dispatches parsed routes to handler", async () => {
    const remove = jest.fn()
    let registered: ((event: { url: string }) => void) | null = null
    const handler = jest.fn()
    const unsub = await subscribe(handler, async () => ({
      addListener: async (_event: string, h: (event: { url: string }) => void) => {
        registered = h
        return { remove }
      },
    }))
    registered!({ url: "cognia://session/sid-1" })
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open_session", sessionId: "sid-1" })
    )
    unsub()
    expect(remove).toHaveBeenCalled()
  })

  it("returns no-op unsub when plugin missing", async () => {
    const unsub = await subscribe(jest.fn(), async () => {
      throw new Error("nope")
    })
    expect(typeof unsub).toBe("function")
    expect(() => unsub()).not.toThrow()
  })
})

describe("getLaunchRoute", () => {
  it("returns parsed route for launch URL", async () => {
    const route = await getLaunchRoute(async () => ({
      addListener: jest.fn(),
      getLaunchUrl: async () => ({ url: "cognia://oauth/claude?code=c" }),
    }))
    expect(route?.kind).toBe("oauth_callback")
  })

  it("returns null when no launch URL", async () => {
    const route = await getLaunchRoute(async () => ({
      addListener: jest.fn(),
      getLaunchUrl: async () => null,
    }))
    expect(route).toBeNull()
  })

  it("returns null when plugin missing", async () => {
    const route = await getLaunchRoute(async () => {
      throw new Error("nope")
    })
    expect(route).toBeNull()
  })
})
