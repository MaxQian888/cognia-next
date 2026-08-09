import type { LogtoDrivers } from "./client"

export const LOGTO_CALLBACK_STATE_KEY = "cognia.logto.callback.state"

interface LogtoCallbackMessage {
  __cogniaLogto: true
  code: string | null
  state: string | null
  error: string | null
}

export function createLogtoWebPopupDrivers(fetchImpl?: typeof fetch): LogtoDrivers {
  return {
    fetchImpl,
    openUrl: (url) => {
      const state = new URL(url).searchParams.get("state")
      if (!state) throw new Error("Logto authorize URL is missing state")
      window.localStorage.setItem(LOGTO_CALLBACK_STATE_KEY, state)
      const popup = window.open(url, "cognia-logto", "popup,width=520,height=720")
      if (!popup) {
        window.localStorage.removeItem(LOGTO_CALLBACK_STATE_KEY)
        throw new Error("Logto popup was blocked")
      }
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
