/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: {
    onEvent: jest.fn(),
    createSession: jest.fn(),
    closeSession: jest.fn(),
    subscribeFrames: jest.fn(),
    rpc: jest.fn(),
  },
}))

import { localBrowser, type LocalBrowserEvent } from "@/lib/browser/local-client"
import {
  ensureTaggedPage,
  resetSharedLocalBrowserForTests,
  sharedLocalBrowserStore,
} from "@/lib/browser/shared-local-browser"
import type { BrowserPageSummary } from "@/lib/browser/session-types"

import { useSharedLocalBrowser } from "./use-shared-local-browser"

const client = localBrowser as unknown as Record<string, jest.Mock>
let pages: BrowserPageSummary[] = []
let nextPage = 0
let emit: (event: LocalBrowserEvent) => void = () => undefined
let deliverFrame: (bytes: Uint8Array) => void = () => undefined
let releaseNavigation: (() => void) | null = null

function addPage(active = false): BrowserPageSummary {
  nextPage += 1
  const page = { id: `p${nextPage}`, url: "about:blank", title: "", active }
  if (active) for (const other of pages) other.active = false
  pages.push(page)
  return page
}

function pagesChanged() {
  act(() =>
    emit({
      type: "pages.changed",
      sessionId: "shared-1",
      pages: pages.map((page) => ({ ...page })),
      activePageId: pages.find((page) => page.active)?.id ?? null,
    })
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  pages = []
  nextPage = 0
  releaseNavigation = null
  resetSharedLocalBrowserForTests({ createSessionId: () => "shared-1" })
  client.onEvent.mockImplementation(async (callback) => {
    emit = callback
    return jest.fn()
  })
  client.createSession.mockImplementation(async ({ id }) => {
    addPage(true)
    return { id }
  })
  client.closeSession.mockResolvedValue(undefined)
  client.subscribeFrames.mockImplementation(async (_id, callback) => {
    deliverFrame = callback
    return jest.fn()
  })
  client.rpc.mockImplementation(async (op: string, payload: Record<string, unknown>) => {
    switch (op) {
      case "browser.pages":
        return pages.map((page) => ({ ...page }))
      case "browser.page.create":
        return { ...addPage(payload.activate !== false) }
      case "browser.page.activate":
        for (const page of pages) page.active = page.id === payload.pageId
        return undefined
      case "browser.page.close":
        pages = pages.filter((page) => page.id !== payload.pageId)
        return undefined
      case "browser.navigate": {
        if (releaseNavigation === null && payload.url === "https://slow.test/") {
          await new Promise<void>((resolve) => {
            releaseNavigation = resolve
          })
        }
        const page = pages.find((entry) => entry.id === payload.pageId)
        if (page) page.url = String(payload.url)
        return { ok: true }
      }
      default:
        return { ok: true }
    }
  })
})

function renderPane(options: Partial<Parameters<typeof useSharedLocalBrowser>[0]> = {}) {
  const onFrame = jest.fn()
  const hook = renderHook(
    (props: Parameters<typeof useSharedLocalBrowser>[0]) => useSharedLocalBrowser(props),
    {
      initialProps: { owner: "chat:s1", onFrame, ...options },
    }
  )
  return { ...hook, onFrame }
}

describe("a dock page tab", () => {
  it("clears a failed first load after navigating to an edited address", async () => {
    const rpc = client.rpc.getMockImplementation()!
    client.rpc.mockImplementation(async (op, payload) => {
      if (op === "browser.navigate" && payload.url === "https://broken.test/") {
        throw new Error("net::ERR_CONNECTION_REFUSED")
      }
      return rpc(op, payload)
    })
    const { result } = renderPane({ tag: "t1", initialUrl: "https://broken.test/" })
    await waitFor(() => expect(result.current.state).toBe("failed"))
    await act(async () => {
      await result.current.engine!.navigate("https://working.test/")
      await result.current.refreshPages()
    })
    expect(result.current.state).toBe("ready")
    expect(result.current.error).toBeNull()
  })

  it("retries the address when a page was created but its first navigation failed", async () => {
    const rpc = client.rpc.getMockImplementation()!
    let failed = false
    client.rpc.mockImplementation(async (op, payload) => {
      if (op === "browser.navigate" && !failed) {
        failed = true
        throw new Error("net::ERR_CONNECTION_REFUSED")
      }
      return rpc(op, payload)
    })
    const { result } = renderPane({ tag: "t1", initialUrl: "https://retry.test/" })
    await waitFor(() => expect(result.current.state).toBe("failed"))
    act(() => result.current.restart())
    await waitFor(() => expect(result.current.state).toBe("ready"))
    expect(client.rpc.mock.calls.filter(([op]) => op === "browser.navigate")).toHaveLength(2)
  })

  it("reopens the tab's page at its address, showing it as restoring meanwhile", async () => {
    const { result } = renderPane({ tag: "t1", initialUrl: "https://slow.test/" })
    await waitFor(() => expect(result.current.restoring).toBe(true))
    expect(result.current.state).toBe("starting")
    act(() => releaseNavigation?.())
    await waitFor(() => expect(result.current.state).toBe("ready"))
    expect(result.current.restoring).toBe(false)
    const pageId = result.current.activePageId!
    expect(sharedLocalBrowserStore.getState().owned[pageId]).toEqual({
      owner: "chat:s1",
      tag: "t1",
    })
    expect(result.current.engine?.pageId).toBe(pageId)
    expect(client.rpc).toHaveBeenCalledWith("browser.navigate", {
      sessionId: "shared-1",
      pageId,
      url: "https://slow.test/",
    })
  })

  it("shows the page already behind the tab without reloading it, in front and as the focus", async () => {
    const { page } = await ensureTaggedPage("chat:s1", "t1")
    const { result } = renderPane({ tag: "t1", initialUrl: "https://a.test/" })
    await waitFor(() => expect(result.current.state).toBe("ready"))
    expect(result.current.activePageId).toBe(page.id)
    expect(client.rpc).not.toHaveBeenCalledWith("browser.navigate", expect.anything())
    expect(client.rpc).toHaveBeenCalledWith("browser.page.activate", {
      sessionId: "shared-1",
      pageId: page.id,
    })
    expect(sharedLocalBrowserStore.getState().focus["chat:s1"]).toBe(page.id)
  })

  it("keeps its page when it unmounts, and opens it again after the session went away", async () => {
    const { result, unmount } = renderPane({ tag: "t1", initialUrl: "https://a.test/" })
    await waitFor(() => expect(result.current.state).toBe("ready"))
    const first = result.current.activePageId
    pages = []
    act(() => emit({ type: "session.closed", sessionId: "shared-1" }))
    await waitFor(() => expect(result.current.activePageId).not.toBeNull())
    await waitFor(() => expect(result.current.state).toBe("ready"))
    expect(client.createSession).toHaveBeenCalledTimes(2)
    expect(result.current.activePageId).not.toBe(first)
    unmount()
    expect(client.rpc).not.toHaveBeenCalledWith("browser.page.close", expect.anything())
  })

  it("streams the screencast while mounted", async () => {
    const { result, onFrame } = renderPane({ tag: "t1" })
    await waitFor(() => expect(result.current.state).toBe("ready"))
    await waitFor(() => expect(client.subscribeFrames).toHaveBeenCalled())
    deliverFrame(new Uint8Array([7]))
    expect(onFrame).toHaveBeenCalledWith(new Uint8Array([7]))
  })

  it("answers the dialog holding its page", async () => {
    const { result } = renderPane({ tag: "t1" })
    await waitFor(() => expect(result.current.state).toBe("ready"))
    const pageId = result.current.activePageId!
    act(() =>
      emit({
        type: "dialog.opened",
        sessionId: "shared-1",
        pageId,
        dialog: { type: "prompt", message: "Name?", defaultValue: "Ada" },
      })
    )
    expect(result.current.dialog).toEqual({ type: "prompt", message: "Name?", defaultValue: "Ada" })
    await act(() => result.current.answerDialog({ accept: true, promptText: "Grace" }))
    expect(result.current.dialog).toBeNull()
    expect(client.rpc).toHaveBeenCalledWith("browser.dialog.handle", {
      sessionId: "shared-1",
      pageId,
      accept: true,
      promptText: "Grace",
    })
  })

  it("reports a session that cannot start and retries on restart", async () => {
    client.createSession.mockRejectedValueOnce("chromium_not_installed: install it")
    const { result } = renderPane({ tag: "t1" })
    await waitFor(() => expect(result.current.state).toBe("failed"))
    expect(result.current.error).toBe("chromium_not_installed")
    act(() => result.current.restart())
    await waitFor(() => expect(result.current.state).toBe("ready"))
  })
})

describe("a pane outside the dock", () => {
  it("opens a page of its own, switches between its pages, and closes them with it", async () => {
    const { result, unmount } = renderPane({ owner: "pane:x", initialUrl: "https://a.test/" })
    await waitFor(() => expect(result.current.state).toBe("ready"))
    const first = result.current.activePageId!
    await act(() => result.current.createPage())
    pagesChanged()
    expect(result.current.pages).toHaveLength(2)
    const second = result.current.activePageId!
    expect(second).not.toBe(first)
    act(() => result.current.selectPage(first))
    expect(result.current.activePageId).toBe(first)
    await act(() => result.current.closePage(second))
    pagesChanged()
    expect(result.current.pages.map((page) => page.id)).toEqual([first])
    unmount()
    await waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith("browser.page.close", {
        sessionId: "shared-1",
        pageId: first,
      })
    )
  })
})
