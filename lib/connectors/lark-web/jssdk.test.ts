/** @jest-environment jsdom */

import {
  configureLarkJsSdk,
  getLarkTriggerDetail,
  loadLarkJsSdkScript,
  LARK_JSSDK_SCRIPT_URL,
} from "./jssdk"
import { LARK_WEB_SESSION_STORAGE_KEY } from "./session"

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`
}

type SdkGlobals = { h5sdk?: unknown; tt?: unknown }

afterEach(() => {
  delete (globalThis as SdkGlobals).h5sdk
  delete (globalThis as SdkGlobals).tt
  window.sessionStorage.clear()
})

describe("configureLarkJsSdk", () => {
  it("rejects without the SDK global", async () => {
    await expect(
      configureLarkJsSdk({ adapterId: "lk-1", url: "https://x.example/p" })
    ).rejects.toThrow("h5sdk unavailable")
  })

  it("fetches the signature with the session and resolves on ready", async () => {
    window.sessionStorage.setItem(
      LARK_WEB_SESSION_STORAGE_KEY,
      fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    )
    const configured: unknown[] = []
    ;(globalThis as SdkGlobals).h5sdk = {
      error: () => undefined,
      config: (options: { onFail?: (e: unknown) => void }) => configured.push(options),
      ready: (callback: () => void) => callback(),
    }
    const fetchFn = jest.fn(async (url: string) => {
      expect(url).toContain("/integrations/lark/jssdk/config?")
      expect(url).toContain("adapter_id=lk-1")
      return {
        status: 200,
        json: async () => ({ appId: "cli_1", timestamp: 1, nonceStr: "n", signature: "s" }),
      } as unknown as Response
    }) as unknown as typeof fetch
    await configureLarkJsSdk({
      adapterId: "lk-1",
      url: "https://x.example/lark/shortcut",
      apiBase: "",
      fetchFn,
    })
    expect(configured).toHaveLength(1)
    expect((configured[0] as { jsApiList: string[] }).jsApiList).toEqual([
      "getBlockActionSourceDetail",
    ])
  })
})

describe("getLarkTriggerDetail", () => {
  it("rejects without the tt global and resolves through the callback API", async () => {
    await expect(getLarkTriggerDetail("t1")).rejects.toThrow("unavailable")
    ;(globalThis as SdkGlobals).tt = {
      getBlockActionSourceDetail: (options: {
        triggerCode: string
        success: (d: unknown) => void
      }) => {
        expect(options.triggerCode).toBe("t9")
        options.success({ chat_id: "oc_1" })
      },
    }
    await expect(getLarkTriggerDetail("t9")).resolves.toEqual({ chat_id: "oc_1" })
  })
})

describe("loadLarkJsSdkScript", () => {
  afterEach(() => {
    document.querySelectorAll("script").forEach((s) => s.remove())
  })

  it("resolves immediately when the SDK is pre-injected", async () => {
    ;(globalThis as SdkGlobals).tt = {}
    await expect(loadLarkJsSdkScript(50)).resolves.toBeUndefined()
    expect(document.querySelector("script")).toBeNull()
  })

  it("injects the script once and resolves on load / rejects on error", async () => {
    const loading = loadLarkJsSdkScript(1000)
    const script = document.querySelector(`script[src="${LARK_JSSDK_SCRIPT_URL}"]`)
    expect(script).not.toBeNull()
    script!.dispatchEvent(new Event("load"))
    await expect(loading).resolves.toBeUndefined()

    // A second call reuses the existing tag instead of double-injecting.
    const again = loadLarkJsSdkScript(1000)
    expect(document.querySelectorAll("script")).toHaveLength(1)
    script!.dispatchEvent(new Event("error"))
    await expect(again).rejects.toThrow("failed to load")
  })
})
