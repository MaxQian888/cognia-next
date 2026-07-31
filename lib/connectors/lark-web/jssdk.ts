/**
 * Lark H5 JSSDK seam (plan 2026-07-24 P5.1).
 *
 * `window.h5sdk` / `window.tt` only exist inside Lark's webview after the
 * official SDK script loads. Everything here is defensive: outside Lark
 * (or before the script lands) the helpers reject and the caller renders
 * an explanatory error instead of crashing. H5 pages must complete
 * `h5sdk.config` signature auth (companion `/integrations/lark/jssdk/
 * config`) before privileged APIs like `getBlockActionSourceDetail`.
 */

import { getLarkWebSession } from "./session"

export const LARK_JSSDK_SCRIPT_URL =
  "https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.35.js"

interface LarkH5Sdk {
  config: (options: {
    appId: string
    timestamp: number
    nonceStr: string
    signature: string
    jsApiList: string[]
    onSuccess?: () => void
    onFail?: (err: unknown) => void
  }) => void
  ready: (callback: () => void) => void
  error: (callback: (err: unknown) => void) => void
}

interface LarkTt {
  getBlockActionSourceDetail: (options: {
    triggerCode: string
    success: (detail: unknown) => void
    fail: (err: unknown) => void
  }) => void
}

function h5sdk(): LarkH5Sdk | undefined {
  return (globalThis as { h5sdk?: LarkH5Sdk }).h5sdk
}

function tt(): LarkTt | undefined {
  return (globalThis as { tt?: LarkTt }).tt
}

/** Best-effort webview detection — used only to shape error messaging. */
export function isInsideLarkWebview(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
  return /Lark|Feishu/i.test(ua)
}

/**
 * Inject the official SDK script once and wait for `window.h5sdk`/`tt`.
 * Resolves immediately when the SDK is already present (Lark clients often
 * pre-inject it); rejects after `timeoutMs` so callers can render an error.
 */
export function loadLarkJsSdkScript(timeoutMs = 8000): Promise<void> {
  if (h5sdk() || tt()) return Promise.resolve()
  if (typeof document === "undefined") return Promise.reject(new Error("no document"))
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${LARK_JSSDK_SCRIPT_URL}"]`)
    const script = existing ?? document.createElement("script")
    const timer = setTimeout(() => reject(new Error("jssdk script timeout")), timeoutMs)
    script.addEventListener("load", () => {
      clearTimeout(timer)
      resolve()
    })
    script.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("jssdk script failed to load"))
    })
    if (!existing) {
      ;(script as HTMLScriptElement).src = LARK_JSSDK_SCRIPT_URL
      ;(script as HTMLScriptElement).async = true
      document.head.appendChild(script)
    }
  })
}

export interface ConfigureJsSdkOptions {
  adapterId: string
  /** Current page URL WITHOUT the fragment — the signature covers it. */
  url: string
  apiBase?: string
  fetchFn?: typeof fetch
}

/**
 * Fetch signature parameters from the companion and run `h5sdk.config`.
 * Resolves once the SDK reports ready; rejects on any failure.
 */
export async function configureLarkJsSdk(options: ConfigureJsSdkOptions): Promise<void> {
  const sdk = h5sdk()
  if (!sdk) throw new Error("h5sdk unavailable")
  const fetchFn = options.fetchFn ?? (globalThis.fetch as typeof fetch | undefined)
  const session = getLarkWebSession()
  if (!fetchFn || !session) throw new Error("jssdk config prerequisites missing")

  const apiBase = (options.apiBase ?? process.env.NEXT_PUBLIC_COGNIA_LARK_API_BASE ?? "")
    .trim()
    .replace(/\/+$/, "")
  const query = new URLSearchParams({ adapter_id: options.adapterId, url: options.url })
  const response = await fetchFn(`${apiBase}/integrations/lark/jssdk/config?${query.toString()}`, {
    headers: { Authorization: `Bearer ${session}` },
  })
  if (response.status !== 200) throw new Error("jssdk config request failed")
  const config = (await response.json()) as {
    appId: string
    timestamp: number
    nonceStr: string
    signature: string
  }

  await new Promise<void>((resolve, reject) => {
    sdk.error((err) => reject(new Error(`h5sdk error: ${JSON.stringify(err)}`)))
    sdk.config({
      ...config,
      jsApiList: ["getBlockActionSourceDetail"],
      onFail: (err) => reject(new Error(`h5sdk config failed: ${JSON.stringify(err)}`)),
    })
    sdk.ready(() => resolve())
  })
}

/** Exchange a message-shortcut trigger code for the selected messages. */
export function getLarkTriggerDetail(triggerCode: string): Promise<unknown> {
  const api = tt()
  if (!api?.getBlockActionSourceDetail) {
    return Promise.reject(new Error("tt.getBlockActionSourceDetail unavailable"))
  }
  return new Promise((resolve, reject) => {
    api.getBlockActionSourceDetail({
      triggerCode,
      success: resolve,
      fail: (err) => reject(new Error(`getBlockActionSourceDetail failed: ${JSON.stringify(err)}`)),
    })
  })
}
