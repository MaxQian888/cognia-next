/**
 * @jest-environment jsdom
 */
import { awaitCallback } from "./mobile-flow"

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
