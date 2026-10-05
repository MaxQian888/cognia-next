/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import LogtoCallbackPage from "./page"
import { LOGTO_CALLBACK_STATE_KEY } from "@/lib/logto/web-popup"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key,
}))

function landOn(search: string, opener: { postMessage: jest.Mock } | null, state = "state-a") {
  Object.defineProperty(window, "opener", { value: opener, configurable: true })
  window.localStorage.setItem(LOGTO_CALLBACK_STATE_KEY, state)
  window.history.replaceState({}, "", `/logto/callback${search}`)
}

let close: jest.SpyInstance
beforeEach(() => {
  close = jest.spyOn(window, "close").mockImplementation(() => undefined)
})
afterEach(() => close.mockRestore())

it("posts a state-validated callback only to the same-origin opener, then closes", async () => {
  const postMessage = jest.fn()
  landOn("?code=code-a&state=state-a", { postMessage })

  render(<LogtoCallbackPage />)

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ code: "code-a", state: "state-a", error: null }),
    window.location.origin
  )
  expect(await screen.findByText("doneTitle")).toBeInTheDocument()
  expect(screen.getByTestId("mobile-spot-icon-workspace-trust")).toBeInTheDocument()
  expect(close).toHaveBeenCalled()
  // A browser that refused the scripted close still has a way out.
  fireEvent.click(screen.getByRole("button", { name: "close" }))
  expect(close).toHaveBeenCalledTimes(2)
})

it("says a refused sign-in failed instead of claiming it is done, and stays open", async () => {
  const postMessage = jest.fn()
  landOn("?error=access_denied&state=state-a", { postMessage })
  render(<LogtoCallbackPage />)
  expect(await screen.findByText("failedTitle")).toBeInTheDocument()
  expect(screen.getByTestId("logto-callback-reason")).toHaveTextContent("cancelled")
  // Decorative: the heading says what happened.
  expect(screen.getByTestId("mobile-spot-icon-diagnostics")).toHaveAttribute("alt", "")
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ error: "access_denied" }),
    window.location.origin
  )
  expect(close).not.toHaveBeenCalled()
})

it("names a response that belongs to another sign-in, and a provider error", async () => {
  landOn("?code=code-a&state=forged", { postMessage: jest.fn() })
  const first = render(<LogtoCallbackPage />)
  expect(await screen.findByTestId("logto-callback-reason")).toHaveTextContent("stateMismatch")
  first.unmount()

  landOn("?error=server_error&state=state-a", { postMessage: jest.fn() })
  render(<LogtoCallbackPage />)
  expect(await screen.findByTestId("logto-callback-reason")).toHaveTextContent(
    "providerError(server_error)"
  )
})

it("explains a window with nobody to hand the code to", async () => {
  landOn("?code=code-a&state=state-a", null)
  render(<LogtoCallbackPage />)
  expect(await screen.findByText("orphanedTitle")).toBeInTheDocument()
  expect(screen.getByTestId("mobile-spot-icon-diagnostics")).toBeInTheDocument()
  expect(close).not.toHaveBeenCalled()
})
