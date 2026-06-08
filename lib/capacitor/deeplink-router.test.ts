/**
 * @jest-environment jsdom
 */
import { dispatchRoute, makeRouterNavigators } from "./deeplink-router"
import type { DeeplinkNavigators } from "./deeplink-router"

function makeNavigators(): DeeplinkNavigators & {
  pushSession: jest.Mock
  openShareTarget: jest.Mock
  redeemPair: jest.Mock
  openWorkflowRun: jest.Mock
} {
  return {
    pushSession: jest.fn(),
    openShareTarget: jest.fn(),
    redeemPair: jest.fn(),
    openWorkflowRun: jest.fn(),
  }
}

describe("dispatchRoute", () => {
  it("routes open_session to pushSession", () => {
    const navs = makeNavigators()
    dispatchRoute(
      { kind: "open_session", sessionId: "sess-1", raw: "cognia://session/sess-1" },
      navs
    )
    expect(navs.pushSession).toHaveBeenCalledWith("sess-1")
    expect(navs.openShareTarget).not.toHaveBeenCalled()
    expect(navs.redeemPair).not.toHaveBeenCalled()
  })

  it("ignores open_session with empty sessionId", () => {
    const navs = makeNavigators()
    dispatchRoute({ kind: "open_session", sessionId: "", raw: "cognia://session/" }, navs)
    expect(navs.pushSession).not.toHaveBeenCalled()
  })

  it("routes share_target with text+url to openShareTarget", () => {
    const navs = makeNavigators()
    dispatchRoute(
      {
        kind: "share_target",
        text: "hello",
        url: "https://example.com",
        raw: "cognia://share?text=hello&url=https%3A%2F%2Fexample.com",
      },
      navs
    )
    expect(navs.openShareTarget).toHaveBeenCalledWith({
      text: "hello",
      url: "https://example.com",
    })
  })

  it("routes share_target with text only", () => {
    const navs = makeNavigators()
    dispatchRoute({ kind: "share_target", text: "hi", raw: "cognia://share?text=hi" }, navs)
    expect(navs.openShareTarget).toHaveBeenCalledWith({ text: "hi", url: undefined })
  })

  it("routes pair_qr to redeemPair", () => {
    const navs = makeNavigators()
    dispatchRoute(
      { kind: "pair_qr", payload: "cgnp2|abc", raw: "cognia://pair?payload=cgnp2|abc" },
      navs
    )
    expect(navs.redeemPair).toHaveBeenCalledWith("cgnp2|abc")
  })

  it("does nothing for oauth_callback (handled by mobile-flow)", () => {
    const navs = makeNavigators()
    dispatchRoute(
      {
        kind: "oauth_callback",
        provider: "claude",
        code: "x",
        state: null,
        raw: "cognia://oauth/claude?code=x",
      },
      navs
    )
    expect(navs.pushSession).not.toHaveBeenCalled()
    expect(navs.openShareTarget).not.toHaveBeenCalled()
    expect(navs.redeemPair).not.toHaveBeenCalled()
  })

  it("does nothing for unknown routes (just logs)", () => {
    const navs = makeNavigators()
    dispatchRoute({ kind: "unknown", raw: "cognia://nope" }, navs)
    expect(navs.pushSession).not.toHaveBeenCalled()
    expect(navs.openShareTarget).not.toHaveBeenCalled()
    expect(navs.redeemPair).not.toHaveBeenCalled()
  })

  it("routes open_workflow_run with both ids to openWorkflowRun", () => {
    const navs = makeNavigators()
    dispatchRoute(
      {
        kind: "open_workflow_run",
        workflowId: "wf_abc",
        runId: "run_xyz",
        raw: "cognia://workflow-run/wf_abc/run_xyz",
      },
      navs
    )
    expect(navs.openWorkflowRun).toHaveBeenCalledWith({
      workflowId: "wf_abc",
      runId: "run_xyz",
    })
  })

  it("skips open_workflow_run when either id is missing", () => {
    const navs = makeNavigators()
    dispatchRoute(
      {
        kind: "open_workflow_run",
        workflowId: "",
        runId: "run_xyz",
        raw: "cognia://workflow-run//run_xyz",
      },
      navs
    )
    expect(navs.openWorkflowRun).not.toHaveBeenCalled()
  })
})

describe("makeRouterNavigators", () => {
  it("URL-encodes session ids when pushing", () => {
    const push = jest.fn()
    const navs = makeRouterNavigators({ push })
    navs.pushSession("a/b")
    expect(push).toHaveBeenCalledWith("/inbox/c/a%2Fb")
  })

  it("builds /share-target?text=&url= with encoded params", () => {
    const push = jest.fn()
    const navs = makeRouterNavigators({ push })
    navs.openShareTarget({ text: "hi & bye", url: "https://x?a=1" })
    const arg = push.mock.calls[0]?.[0] as string
    expect(arg.startsWith("/share-target?")).toBe(true)
    const query = new URLSearchParams(arg.split("?")[1])
    expect(query.get("text")).toBe("hi & bye")
    expect(query.get("url")).toBe("https://x?a=1")
  })

  it("falls back to /share-target when there is no text or url", () => {
    const push = jest.fn()
    const navs = makeRouterNavigators({ push })
    navs.openShareTarget({})
    expect(push).toHaveBeenCalledWith("/share-target")
  })

  it("URL-encodes pair payloads", () => {
    const push = jest.fn()
    const navs = makeRouterNavigators({ push })
    navs.redeemPair("cgnp2|abc def")
    expect(push).toHaveBeenCalledWith("/pair?payload=cgnp2%7Cabc%20def")
  })

  it("URL-encodes workflow run ids when pushing", () => {
    const push = jest.fn()
    const navs = makeRouterNavigators({ push })
    navs.openWorkflowRun({ workflowId: "wf/abc", runId: "run/xyz" })
    expect(push).toHaveBeenCalledWith("/workflows/run?id=wf%2Fabc&runId=run%2Fxyz")
  })
})
