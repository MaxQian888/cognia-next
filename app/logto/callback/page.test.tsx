/** @jest-environment jsdom */

import { render } from "@testing-library/react"
import LogtoCallbackPage from "./page"
import { LOGTO_CALLBACK_STATE_KEY } from "@/lib/logto/web-popup"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

it("posts a state-validated callback only to the same-origin opener", () => {
  const postMessage = jest.fn()
  const close = jest.spyOn(window, "close").mockImplementation(() => undefined)
  Object.defineProperty(window, "opener", { value: { postMessage }, configurable: true })
  window.localStorage.setItem(LOGTO_CALLBACK_STATE_KEY, "state-a")
  window.history.replaceState({}, "", "/logto/callback?code=code-a&state=state-a")

  render(<LogtoCallbackPage />)

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ code: "code-a", state: "state-a", error: null }),
    window.location.origin
  )
  close.mockRestore()
})
