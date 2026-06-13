/**
 * @jest-environment jsdom
 */

import { render, act } from "@testing-library/react"
import DeepLinkPage from "./page"
import {
  registerUriHandler,
  __resetUriHandlersForTesting,
} from "@/lib/plugin/uri/uri-handler-registry"
import type { ParsedDeepLink } from "@/lib/plugin/uri/parse-deep-link"

const handleActivationEvent = jest.fn(async () => {})

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ handleActivationEvent }),
}))

afterEach(() => {
  __resetUriHandlersForTesting()
  handleActivationEvent.mockClear()
  window.history.replaceState({}, "", "/")
})

describe("DeepLinkPage", () => {
  it("converts the ?u= entry and dispatches to the plugin handler", async () => {
    const seen: ParsedDeepLink[] = []
    registerUriHandler("acme", (uri) => void seen.push(uri))
    const url = encodeURIComponent("cognia://plugin/acme/open?x=1")
    window.history.replaceState({}, "", `/deep-link?u=${url}`)

    await act(async () => {
      render(<DeepLinkPage />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(handleActivationEvent).toHaveBeenCalledWith("onUri:acme")
    expect(seen[0]?.path).toBe("open")
    expect(seen[0]?.query.x).toBe("1")
  })

  it("no-ops without a ?u= param", async () => {
    window.history.replaceState({}, "", "/deep-link")
    await act(async () => {
      render(<DeepLinkPage />)
      await Promise.resolve()
    })
    expect(handleActivationEvent).not.toHaveBeenCalled()
  })

  it("ignores a non-plugin ?u= url", async () => {
    const url = encodeURIComponent("cognia://connector/oauth/lark")
    window.history.replaceState({}, "", `/deep-link?u=${url}`)
    await act(async () => {
      render(<DeepLinkPage />)
      await Promise.resolve()
    })
    expect(handleActivationEvent).not.toHaveBeenCalled()
  })

  it("still dispatches when lazy activation rejects", async () => {
    handleActivationEvent.mockRejectedValueOnce(new Error("manager down"))
    const seen: ParsedDeepLink[] = []
    registerUriHandler("acme", (uri) => void seen.push(uri))
    const url = encodeURIComponent("cognia://plugin/acme/open")
    window.history.replaceState({}, "", `/deep-link?u=${url}`)
    await act(async () => {
      render(<DeepLinkPage />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(seen[0]?.path).toBe("open")
  })
})
