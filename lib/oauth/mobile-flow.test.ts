/**
 * @jest-environment jsdom
 */
import { awaitCallback, runOAuth } from "./mobile-flow"

jest.mock("@/lib/capacitor/browser", () => ({
  open: jest.fn(),
  close: jest.fn(),
  onClose: jest.fn(),
}))
jest.mock("@/lib/capacitor/deeplink", () => ({
  ...jest.requireActual("@/lib/capacitor/deeplink"),
  subscribe: jest.fn(),
}))

describe("awaitCallback", () => {
  it("resolves via deeplink when matching route arrives", async () => {
    let pushRoute: ((url: string) => void) | null = null
    const subscribe = (
      handler: (route: { kind: string; provider?: string; code?: string; state?: string }) => void
    ) => {
      pushRoute = (raw) => {
        const url = new URL(raw)
        handler({
          kind: "oauth_callback",
          provider: url.pathname.replace("/", ""),
          code: url.searchParams.get("code") ?? undefined,
          state: url.searchParams.get("state") ?? undefined,
        })
      }
      return Promise.resolve(() => {})
    }

    const promise = awaitCallback({
      provider: "claude",
      timeoutMs: 1000,
      // @ts-expect-error narrowed shape for the test
      subscribe,
    })
    await new Promise((r) => setTimeout(r, 0))
    pushRoute!("cognia://oauth/claude?code=abc&state=xyz")
    const out = await promise
    expect(out).toEqual({
      kind: "ok",
      result: { code: "abc", state: "xyz", via: "deeplink" },
    })
  })

  it("ignores deeplinks for other providers", async () => {
    let pushRoute: ((url: string) => void) | null = null
    const subscribe = (
      handler: (route: { kind: string; provider?: string; code?: string; state?: string }) => void
    ) => {
      pushRoute = (raw) => {
        const url = new URL(raw)
        handler({
          kind: "oauth_callback",
          provider: url.pathname.replace("/", ""),
          code: url.searchParams.get("code") ?? undefined,
          state: url.searchParams.get("state") ?? undefined,
        })
      }
      return Promise.resolve(() => {})
    }

    const promise = awaitCallback({
      provider: "claude",
      timeoutMs: 200,
      // @ts-expect-error narrowed shape for the test
      subscribe,
    })
    await new Promise((r) => setTimeout(r, 0))
    pushRoute!("cognia://oauth/slack?code=zzz")
    const out = await promise
    expect(out).toEqual({ kind: "timeout" })
  })

  it("lets the caller decide which deep links settle the wait", async () => {
    let push: ((route: unknown) => void) | null = null
    const subscribe = ((handler: (route: unknown) => void) => {
      push = handler
      return Promise.resolve(() => {})
    }) as never
    const accept = (route: { kind: string; state?: string | null; code?: string | null }) => {
      if (route.kind !== "logto_callback") return null
      if (route.state !== "st") return "mismatch" as const
      return { code: route.code!, state: route.state }
    }
    const promise = awaitCallback({ provider: "logto", timeoutMs: 1000, subscribe, accept })
    await new Promise((r) => setTimeout(r, 0))
    push!({ kind: "oauth_callback", provider: "logto", code: "ignored", state: "st", raw: "" })
    push!({ kind: "logto_callback", code: "c-1", state: "st", error: null, raw: "" })
    expect(await promise).toEqual({
      kind: "ok",
      result: { code: "c-1", state: "st", via: "deeplink" },
    })

    const refused = awaitCallback({
      provider: "logto",
      timeoutMs: 1000,
      subscribe,
      accept: () => ({ error: "access_denied" }),
    })
    await new Promise((r) => setTimeout(r, 0))
    push!({ kind: "logto_callback", code: null, state: "st", error: "access_denied", raw: "" })
    expect(await refused).toEqual({ kind: "error", error: "access_denied" })
  })

  it("resolves via manualPaste race", async () => {
    const subscribe = (() => Promise.resolve(() => {})) as never
    const out = await awaitCallback({
      provider: "claude",
      manualPaste: async () => ({ code: "manual-code", state: null }),
      timeoutMs: 1000,
      subscribe,
    })
    expect(out).toEqual({
      kind: "ok",
      result: { code: "manual-code", state: null, via: "manual" },
    })
  })

  it("returns mismatch when deeplink has no code", async () => {
    let pushRoute: ((url: string) => void) | null = null
    const subscribe = (
      handler: (route: { kind: string; provider?: string; code?: string | null }) => void
    ) => {
      pushRoute = (raw) => {
        const url = new URL(raw)
        handler({
          kind: "oauth_callback",
          provider: url.pathname.replace("/", ""),
          code: null,
        })
      }
      return Promise.resolve(() => {})
    }
    const promise = awaitCallback({
      provider: "claude",
      timeoutMs: 1000,
      subscribe: subscribe as never,
    })
    await new Promise((r) => setTimeout(r, 0))
    pushRoute!("cognia://oauth/claude")
    const out = await promise
    expect(out).toEqual({ kind: "mismatch" })
  })

  it("returns timeout when nothing happens", async () => {
    const subscribeFn = () => Promise.resolve(() => {})
    const out = await awaitCallback({
      provider: "claude",
      timeoutMs: 50,
      subscribe: subscribeFn as never,
    })
    expect(out).toEqual({ kind: "timeout" })
  })
})

describe("runOAuth native browser lifecycle", () => {
  const browser = jest.requireMock("@/lib/capacitor/browser")
  const deeplink = jest.requireMock("@/lib/capacitor/deeplink")
  let dismiss: () => void
  let callback: (route: unknown) => void
  const removeClose = jest.fn()
  const removeLink = jest.fn()
  beforeEach(() => {
    jest.clearAllMocks()
    browser.open.mockResolvedValue({ kind: "ok" })
    browser.close.mockResolvedValue({ kind: "ok" })
    browser.onClose.mockImplementation(async (handler: () => void) => {
      dismiss = handler
      return removeClose
    })
    deeplink.subscribe.mockImplementation(async (handler: (route: unknown) => void) => {
      callback = handler
      return removeLink
    })
  })
  it("returns the launch error and cleans listeners without waiting for timeout", async () => {
    browser.open.mockResolvedValue({ kind: "error", message: "Unable to display URL" })
    expect(await runOAuth({ provider: "logto", authorizeUrl: "https://login.example" })).toEqual({
      kind: "error",
      error: "Unable to display URL",
    })
    expect(removeClose).toHaveBeenCalledTimes(1)
    expect(removeLink).toHaveBeenCalledTimes(1)
    expect(browser.close).toHaveBeenCalledTimes(1)
  })
  it("cancels immediately when the user dismisses the browser", async () => {
    browser.open.mockImplementation(async () => {
      dismiss()
      return { kind: "ok" }
    })
    expect(await runOAuth({ provider: "logto", authorizeUrl: "https://login.example" })).toEqual({
      kind: "cancelled",
    })
    expect(removeLink).toHaveBeenCalledTimes(1)
    expect(removeClose).toHaveBeenCalledTimes(1)
  })
  it("captures a callback fired while open is resolving", async () => {
    browser.open.mockImplementation(async () => {
      callback({ kind: "oauth_callback", provider: "logto", code: "code", state: "state" })
      return { kind: "ok" }
    })
    expect(
      await runOAuth({ provider: "logto", authorizeUrl: "https://login.example" })
    ).toMatchObject({ kind: "ok", result: { code: "code" } })
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(removeLink).toHaveBeenCalledTimes(1)
  })
  it("does not open for a pre-aborted request", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      await runOAuth({
        provider: "logto",
        authorizeUrl: "https://login.example",
        signal: controller.signal,
      })
    ).toEqual({ kind: "cancelled" })
    expect(browser.open).not.toHaveBeenCalled()
  })
  it("cleans a listener that finishes registering after cancellation", async () => {
    const controller = new AbortController()
    let complete!: (remove: () => void) => void
    deeplink.subscribe.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const result = runOAuth({
      provider: "logto",
      authorizeUrl: "https://login.example",
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    complete(removeLink)
    expect(await result).toEqual({ kind: "cancelled" })
    expect(removeLink).toHaveBeenCalledTimes(1)
    expect(browser.open).not.toHaveBeenCalled()
  })

  it("cancels while browser open is pending and closes a late-opened browser", async () => {
    let finish!: (result: unknown) => void
    browser.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const result = runOAuth({
      provider: "logto",
      authorizeUrl: "https://login.example",
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    expect(await result).toEqual({ kind: "cancelled" })
    expect(removeLink).toHaveBeenCalledTimes(1)
    expect(browser.close).toHaveBeenCalledTimes(1)
    finish({ kind: "ok" })
    await Promise.resolve()
    expect(browser.close).toHaveBeenCalledTimes(2)
  })
  it("keeps manual paste active when the user leaves the browser", async () => {
    let paste!: (result: { code: string; state: null }) => void
    browser.open.mockImplementationOnce(async () => {
      dismiss()
      return { kind: "ok" }
    })
    const result = runOAuth({
      provider: "claude",
      authorizeUrl: "https://login.example",
      manualPaste: () =>
        new Promise((resolve) => {
          paste = resolve
        }),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    paste({ code: "copied", state: null })
    expect(await result).toMatchObject({ kind: "ok", result: { code: "copied", via: "manual" } })
  })
  it("does not close a newer browser when an aborted older open finishes", async () => {
    let finish!: (result: unknown) => void
    browser.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const old = new AbortController()
    const first = runOAuth({
      provider: "logto",
      authorizeUrl: "https://login.example",
      signal: old.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    old.abort()
    await first
    const current = new AbortController()
    const second = runOAuth({
      provider: "logto",
      authorizeUrl: "https://login.example",
      signal: current.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    browser.close.mockClear()
    finish({ kind: "ok" })
    await Promise.resolve()
    expect(browser.close).not.toHaveBeenCalled()
    current.abort()
    await second
  })
  it("handles manual input rejection as cancellation", async () => {
    expect(
      await awaitCallback({
        provider: "logto",
        manualPaste: async () => {
          throw new Error("dismissed")
        },
        subscribe: async () => removeLink,
      })
    ).toEqual({ kind: "cancelled" })
  })
})

it("times out even if native listener registration never resolves", async () => {
  const browser = jest.requireMock("@/lib/capacitor/browser")
  const deeplink = jest.requireMock("@/lib/capacitor/deeplink")
  browser.open.mockClear()
  let finishClose!: (remove: () => void) => void
  const remove = jest.fn()
  browser.onClose.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishClose = resolve
      })
  )
  deeplink.subscribe.mockImplementationOnce(() => new Promise(() => {}))
  expect(
    await runOAuth({ provider: "logto", authorizeUrl: "https://login.example", timeoutMs: 10 })
  ).toEqual({ kind: "timeout" })
  finishClose(remove)
  await Promise.resolve()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(browser.open).not.toHaveBeenCalled()
})
