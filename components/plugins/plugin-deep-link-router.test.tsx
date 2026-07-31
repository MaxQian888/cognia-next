/**
 * @jest-environment jsdom
 */

import { render, act } from "@testing-library/react"
import { PluginDeepLinkRouter } from "./plugin-deep-link-router"
import {
  registerUriHandler,
  __resetUriHandlersForTesting,
} from "@/lib/plugin/uri/uri-handler-registry"
import type { ParsedDeepLink } from "@/lib/plugin/uri/parse-deep-link"

let deepLinkHandler: ((urls: string[]) => void) | null = null
let launchUrls: string[] | null = null
const handleActivationEvent = jest.fn(async () => {})

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/deep-link", () => ({
  onDeepLink: async (h: (urls: string[]) => void) => {
    deepLinkHandler = h
    return () => {
      deepLinkHandler = null
    }
  },
  getLaunchDeepLink: async () => launchUrls,
}))
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ handleActivationEvent }),
}))

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  __resetUriHandlersForTesting()
  deepLinkHandler = null
  launchUrls = null
  handleActivationEvent.mockClear()
})

describe("PluginDeepLinkRouter", () => {
  it("routes a live deep-link to the plugin handler after lazy activation", async () => {
    const seen: ParsedDeepLink[] = []
    registerUriHandler("acme", (uri) => void seen.push(uri))
    render(<PluginDeepLinkRouter />)
    await flush()

    await act(async () => {
      deepLinkHandler?.(["cognia://plugin/acme/auth/callback?code=abc"])
      await Promise.resolve()
    })

    expect(handleActivationEvent).toHaveBeenCalledWith("onUri:acme")
    expect(seen[0]?.path).toBe("auth/callback")
    expect(seen[0]?.query.code).toBe("abc")
  })

  it("routes a cold-start launch URL", async () => {
    launchUrls = ["cognia://plugin/acme/open"]
    const seen: ParsedDeepLink[] = []
    registerUriHandler("acme", (uri) => void seen.push(uri))
    render(<PluginDeepLinkRouter />)
    await flush()
    expect(seen[0]?.path).toBe("open")
  })

  it("ignores non-plugin deep-links", async () => {
    render(<PluginDeepLinkRouter />)
    await flush()
    await act(async () => {
      deepLinkHandler?.(["cognia://connector/oauth/lark?code=1"])
      await Promise.resolve()
    })
    expect(handleActivationEvent).not.toHaveBeenCalled()
  })

  it("still dispatches when lazy activation rejects", async () => {
    handleActivationEvent.mockRejectedValueOnce(new Error("manager down"))
    const seen: ParsedDeepLink[] = []
    registerUriHandler("acme", (uri) => void seen.push(uri))
    render(<PluginDeepLinkRouter />)
    await flush()
    await act(async () => {
      deepLinkHandler?.(["cognia://plugin/acme/x"])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(seen[0]?.path).toBe("x")
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<PluginDeepLinkRouter />)
    await flush()
    expect(deepLinkHandler).not.toBeNull()
    unmount()
    expect(deepLinkHandler).toBeNull()
  })
})
