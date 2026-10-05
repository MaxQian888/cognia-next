import type { LogtoDrivers } from "./client"

export const LOGTO_CALLBACK_STATE_KEY = "cognia.logto.callback.state"

interface LogtoCallbackMessage {
  __cogniaLogto: true
  code: string | null
  state: string | null
  error: string | null
}

const POPUP_NAME = "cognia-logto"
const POPUP_FEATURES = "popup,width=520,height=720"

export interface LogtoWebPopupOptions {
  /**
   * Open the (blank) popup now rather than when the authorize URL is ready.
   *
   * A browser lets a page open a window only while the click that asked for
   * it is still active: Safari ends that at the first network wait, Chrome
   * after about five seconds. Discovery and PKCE come first and can take
   * seconds on their own, so a popup opened at `openUrl` time is often
   * refused. A caller that creates the drivers synchronously inside the click
   * handler passes `true`: the window is reserved while the click still
   * counts, and `openUrl` only points it at the authorize URL. A refused
   * reservation falls back to opening at `openUrl` time.
   */
  reserveWindow?: boolean
}

export function createLogtoWebPopupDrivers(
  fetchImpl?: typeof fetch,
  options: LogtoWebPopupOptions = {}
): LogtoDrivers {
  let reserved: Window | null = options.reserveWindow
    ? window.open("about:blank", POPUP_NAME, POPUP_FEATURES)
    : null
  return {
    fetchImpl,
    openUrl: (url) => {
      const state = new URL(url).searchParams.get("state")
      if (!state) throw new Error("Logto authorize URL is missing state")
      window.localStorage.setItem(LOGTO_CALLBACK_STATE_KEY, state)
      const held = reserved && !reserved.closed ? reserved : null
      reserved = null
      if (held) {
        held.location.replace(url)
        return
      }
      const popup = window.open(url, POPUP_NAME, POPUP_FEATURES)
      if (!popup) {
        window.localStorage.removeItem(LOGTO_CALLBACK_STATE_KEY)
        throw new Error("Logto popup was blocked")
      }
    },
    // A sign-in that failed before reaching `openUrl` (discovery, PKCE) must
    // not leave the reserved blank window behind.
    abandon: () => {
      if (reserved && !reserved.closed) reserved.close()
      reserved = null
    },
    waitForCode: ({ state }) =>
      new Promise((resolve, reject) => {
        const onMessage = (event: MessageEvent<unknown>) => {
          if (event.origin !== window.location.origin || event.source == null) return
          const value = event.data as Partial<LogtoCallbackMessage> | null
          if (!value?.__cogniaLogto) return
          window.removeEventListener("message", onMessage)
          if (value.state !== state) {
            reject(new Error("Logto callback state mismatch"))
          } else if (value.error) {
            reject(new Error(`Logto authorization failed: ${value.error}`))
          } else if (!value.code) {
            reject(new Error("Logto callback is missing code"))
          } else {
            resolve({ code: value.code, state })
          }
        }
        window.addEventListener("message", onMessage)
      }),
  }
}

export function readValidatedLogtoCallback(search: string): LogtoCallbackMessage {
  const params = new URLSearchParams(search)
  const state = params.get("state")
  const expected = window.localStorage.getItem(LOGTO_CALLBACK_STATE_KEY)
  window.localStorage.removeItem(LOGTO_CALLBACK_STATE_KEY)
  if (!state || !expected || state !== expected) {
    return { __cogniaLogto: true, code: null, state, error: "state_mismatch" }
  }
  return {
    __cogniaLogto: true,
    code: params.get("code"),
    state,
    error: params.get("error"),
  }
}
