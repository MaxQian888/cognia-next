jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: jest.fn() }))

import { act, renderHook } from "@testing-library/react"

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import {
  SUBSCRIPTION_CONSENT_VERSION,
  type StatusRuntime,
  type SubscriptionPreferences,
} from "@/lib/status/public-status"

import { StatusRequestError } from "./status-transport"
import {
  classifyStatusActionError,
  readTokenFragment,
  useSubscribe,
  useTokenAction,
} from "./use-subscription-actions"

const primary: StatusRuntime = {
  mode: "primary",
  apiBase: "/api/status/v1",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: true,
}
const mirror: StatusRuntime = { ...primary, mode: "mirror", allowsConsentWrites: false }

const TOKEN = "t".repeat(40)
const fetchMock = jest.fn()

const preferences: SubscriptionPreferences = {
  locale: "en",
  componentIds: [],
  maskedEmail: "a•••@example.com",
  revision: 3,
}

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

function body(callIndex: number) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body)
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  ;(createPlatformFetch as jest.Mock).mockReturnValue(fetchMock)
  window.history.replaceState(null, "", "/status/")
})

describe("classifyStatusActionError", () => {
  it("maps contract codes, bare statuses and transport failures to bounded kinds", () => {
    const http = (status: number, code: string | null = null) =>
      new StatusRequestError("http", { status, code: code as never })
    expect(classifyStatusActionError(http(410, "token_used"))).toBe("token_used")
    expect(classifyStatusActionError(http(410))).toBe("token_expired")
    expect(classifyStatusActionError(http(400, "token_invalid"))).toBe("token_invalid")
    expect(classifyStatusActionError(http(409, "revision_conflict"))).toBe("revision_conflict")
    expect(classifyStatusActionError(http(429))).toBe("rate_limited")
    expect(classifyStatusActionError(http(403))).toBe("forbidden")
    expect(classifyStatusActionError(http(503, "unavailable"))).toBe("unavailable")
    expect(classifyStatusActionError(http(500, "internal"))).toBe("unavailable")
    expect(classifyStatusActionError(new StatusRequestError("timeout"))).toBe("network")
    expect(classifyStatusActionError(new StatusRequestError("invalid"))).toBe("invalid")
    expect(classifyStatusActionError(new Error("boom"))).toBe("network")
  })
})

describe("readTokenFragment", () => {
  it("distinguishes a usable link, a damaged one and no link", () => {
    expect(readTokenFragment(`#action=confirm&token=${TOKEN}`)).toEqual({
      kind: "valid",
      action: "confirm",
      token: TOKEN,
    })
    expect(readTokenFragment("#action=confirm&token=short")).toEqual({ kind: "malformed" })
    expect(readTokenFragment(`#action=delete&token=${TOKEN}`)).toEqual({ kind: "malformed" })
    expect(readTokenFragment("#components")).toBeNull()
    expect(readTokenFragment("")).toBeNull()
  })
})

describe("useSubscribe", () => {
  it("posts the signup with the consent version and reports a pending confirmation, not a subscription", async () => {
    fetchMock.mockResolvedValue(respond(202, { status: "accepted" }))
    const { result } = renderHook(() => useSubscribe(primary))
    act(() =>
      result.current.submit({
        email: "  a@example.com ",
        locale: "zh-CN",
        componentIds: ["relayData"],
      })
    )
    expect(result.current.state).toEqual({ phase: "submitting" })
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe("/api/status/v1/subscriptions")
    expect(body(0)).toEqual({
      email: "a@example.com",
      locale: "zh-CN",
      componentIds: ["relayData"],
      consentVersion: SUBSCRIPTION_CONSENT_VERSION,
    })
    expect(result.current.state).toEqual({ phase: "pending" })
  })

  it.each([
    [429, { code: "rate_limited", requestId: "r" }, "rate_limited"],
    [503, { code: "unavailable", requestId: "r" }, "unavailable"],
    [403, { code: "forbidden", requestId: "r" }, "forbidden"],
  ])("reports HTTP %s as %s", async (status, errorBody, kind) => {
    fetchMock.mockResolvedValue(respond(status, errorBody))
    const { result } = renderHook(() => useSubscribe(primary))
    act(() => result.current.submit({ email: "a@example.com", locale: "en", componentIds: [] }))
    await flush()
    expect(result.current.state).toEqual({ phase: "error", kind })
  })

  it("reports a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"))
    const { result } = renderHook(() => useSubscribe(primary))
    act(() => result.current.submit({ email: "a@example.com", locale: "en", componentIds: [] }))
    await flush()
    expect(result.current.state).toEqual({ phase: "error", kind: "network" })
  })

  it("never posts from a read-only runtime", async () => {
    const { result } = renderHook(() => useSubscribe(mirror))
    act(() => result.current.submit({ email: "a@example.com", locale: "en", componentIds: [] }))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.state).toEqual({ phase: "idle" })
  })
})

describe("useTokenAction", () => {
  it("clears the token from the address bar immediately, keeping path and query", () => {
    window.history.replaceState(null, "", `/status/?incident=inc_1#action=confirm&token=${TOKEN}`)
    const { result } = renderHook(() => useTokenAction(primary))
    expect(result.current.fragment).toMatchObject({ kind: "valid", action: "confirm" })
    expect(window.location.hash).toBe("")
    expect(window.location.pathname).toBe("/status/")
    expect(window.location.search).toBe("?incident=inc_1")
  })

  it("confirms only after an explicit action and shows the confirmed preferences", async () => {
    window.history.replaceState(null, "", `/status/#action=confirm&token=${TOKEN}`)
    fetchMock.mockResolvedValue(respond(200, { status: "confirmed", preferences }))
    const { result } = renderHook(() => useTokenAction(primary))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.state).toEqual({ phase: "ready" })
    act(() => result.current.confirm())
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe("/api/status/v1/subscriptions/confirm")
    expect(fetchMock.mock.calls[0][1].method).toBe("POST")
    expect(body(0)).toEqual({ token: TOKEN })
    expect(result.current.state).toEqual({ phase: "confirmed", preferences })
  })

  it.each([
    [410, "token_expired"],
    [410, "token_used"],
    [400, "token_invalid"],
  ])("explains a %s %s link", async (status, code) => {
    window.history.replaceState(null, "", `/status/#action=confirm&token=${TOKEN}`)
    fetchMock.mockResolvedValue(respond(status, { code, requestId: "r" }))
    const { result } = renderHook(() => useTokenAction(primary))
    act(() => result.current.confirm())
    await flush()
    expect(result.current.state).toEqual({ phase: "error", kind: code })
  })

  it("unsubscribes only on the explicit action", async () => {
    window.history.replaceState(null, "", `/status/#action=unsubscribe&token=${TOKEN}`)
    fetchMock.mockResolvedValue(respond(200, { status: "unsubscribed" }))
    const { result } = renderHook(() => useTokenAction(primary))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => result.current.unsubscribe())
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe("/api/status/v1/subscriptions/unsubscribe")
    expect(body(0)).toEqual({ token: TOKEN })
    expect(result.current.state).toEqual({ phase: "unsubscribed" })
  })

  it("reads preferences for a manage link and saves an update with the expected revision", async () => {
    window.history.replaceState(null, "", `/status/#action=manage&token=${TOKEN}`)
    const updated = {
      ...preferences,
      locale: "zh-CN" as const,
      componentIds: ["relayData" as const],
      revision: 4,
    }
    fetchMock.mockResolvedValueOnce(respond(200, { status: "ok", preferences }))
    fetchMock.mockResolvedValueOnce(respond(200, { status: "ok", preferences: updated }))
    const { result } = renderHook(() => useTokenAction(primary))
    expect(result.current.state).toEqual({ phase: "working" })
    await flush()
    expect(body(0)).toEqual({ token: TOKEN, operation: "read" })
    expect(result.current.state).toMatchObject({ phase: "preferences", preferences, notice: null })

    act(() => result.current.savePreferences({ locale: "zh-CN", componentIds: ["relayData"] }))
    expect(result.current.state).toMatchObject({ phase: "preferences", saving: true })
    await flush()
    expect(body(1)).toEqual({
      token: TOKEN,
      operation: "update",
      expectedRevision: 3,
      locale: "zh-CN",
      componentIds: ["relayData"],
    })
    expect(result.current.state).toMatchObject({
      phase: "preferences",
      preferences: updated,
      notice: "saved",
      saving: false,
    })
  })

  it("reloads the preferences and says so after a revision conflict", async () => {
    window.history.replaceState(null, "", `/status/#action=manage&token=${TOKEN}`)
    const current = { ...preferences, revision: 5, componentIds: ["signalingAuth" as const] }
    fetchMock.mockResolvedValueOnce(respond(200, { status: "ok", preferences }))
    fetchMock.mockResolvedValueOnce(
      respond(409, { code: "revision_conflict", requestId: "r", currentRevision: 5 })
    )
    fetchMock.mockResolvedValueOnce(respond(200, { status: "ok", preferences: current }))
    const { result } = renderHook(() => useTokenAction(primary))
    await flush()
    act(() => result.current.savePreferences({ locale: "en", componentIds: [] }))
    await flush()
    expect(body(2)).toEqual({ token: TOKEN, operation: "read" })
    expect(result.current.state).toMatchObject({
      phase: "preferences",
      preferences: current,
      notice: "conflict",
    })
  })

  it("never posts a token from a mirror", async () => {
    window.history.replaceState(null, "", `/status/#action=unsubscribe&token=${TOKEN}`)
    const { result } = renderHook(() => useTokenAction(mirror))
    act(() => result.current.unsubscribe())
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(window.location.hash).toBe("")
  })

  it("does not read preferences from a mirror either", async () => {
    window.history.replaceState(null, "", `/status/#action=manage&token=${TOKEN}`)
    const { result } = renderHook(() => useTokenAction(mirror))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.state).toEqual({ phase: "ready" })
  })

  it("treats a damaged link as malformed and still clears it", () => {
    window.history.replaceState(null, "", "/status/#action=confirm&token=abc")
    const { result } = renderHook(() => useTokenAction(primary))
    expect(result.current.fragment).toEqual({ kind: "malformed" })
    expect(window.location.hash).toBe("")
  })

  it("leaves an ordinary anchor alone", () => {
    window.history.replaceState(null, "", "/status/#components")
    const { result } = renderHook(() => useTokenAction(primary))
    expect(result.current.fragment).toBeNull()
    expect(window.location.hash).toBe("#components")
  })

  it("can be dismissed", () => {
    window.history.replaceState(null, "", `/status/#action=confirm&token=${TOKEN}`)
    const { result } = renderHook(() => useTokenAction(primary))
    act(() => result.current.dismiss())
    expect(result.current.dismissed).toBe(true)
  })
})
