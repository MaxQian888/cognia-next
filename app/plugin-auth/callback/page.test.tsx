/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import PluginAuthCallbackPage from "./page"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("PluginAuthCallbackPage", () => {
  const originalOpener = window.opener

  afterEach(() => {
    Object.defineProperty(window, "opener", { value: originalOpener, configurable: true })
    window.history.replaceState({}, "", "/")
  })

  it("forwards code+state to window.opener", () => {
    const postMessage = jest.fn()
    Object.defineProperty(window, "opener", { value: { postMessage }, configurable: true })
    window.history.replaceState({}, "", "/plugin-auth/callback?code=abc&state=xyz")

    render(<PluginAuthCallbackPage />)

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __pluginAuth: true, code: "abc", state: "xyz" }),
      window.location.origin
    )
    expect(screen.getByText("done")).toBeInTheDocument()
  })

  it("forwards an error param when present", () => {
    const postMessage = jest.fn()
    Object.defineProperty(window, "opener", { value: { postMessage }, configurable: true })
    window.history.replaceState({}, "", "/plugin-auth/callback?error=access_denied")

    render(<PluginAuthCallbackPage />)
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ error: "access_denied" }),
      window.location.origin
    )
  })

  it("does not throw when there is no opener", () => {
    Object.defineProperty(window, "opener", { value: null, configurable: true })
    window.history.replaceState({}, "", "/plugin-auth/callback?code=c&state=s")
    expect(() => render(<PluginAuthCallbackPage />)).not.toThrow()
  })
})
