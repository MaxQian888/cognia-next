/** @jest-environment jsdom */
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
import type { BrowserPageSummary } from "@/lib/browser/session-types"

import {
  MAX_PAGES_PER_OWNER,
  SHARED_BROWSER_IDLE_CLOSE_MS,
  answerSharedDialog,
  chatPageOwner,
  chatSessionOfOwner,
  ensureOwnerFocusPage,
  ensureSharedLocalBrowser,
  ensureTaggedPage,
  openOwnedPage,
  ownedPageEngine,
  ownerPages,
  releaseOwner,
  resetSharedLocalBrowserForTests,
  setFocusPageTagResolver,
  sharedLocalBrowserStore,
  subscribeSharedFrames,
  taggedPage,
} from "./shared-local-browser"

const client = localBrowser as unknown as Record<string, jest.Mock>

/** A runtime with one session: pages in order, one in front. */
let pages: BrowserPageSummary[] = []
let nextPage = 0
let emit: (event: LocalBrowserEvent) => void = () => undefined
const unsubscribeFrames = jest.fn()

function summary() {
  return pages.map((page) => ({ ...page }))
}

function pagesChanged() {
  emit({
    type: "pages.changed",
    sessionId: "shared-1",
    pages: summary(),
    activePageId: pages.find((page) => page.active)?.id ?? null,
  })
}

function addPage(url = "about:blank", active = false, openerId?: string): BrowserPageSummary {
  nextPage += 1
  const page: BrowserPageSummary = {
    id: `p${nextPage}`,
    url,
    title: "",
    active,
    ...(openerId ? { openerId } : {}),
  }
  if (active) for (const other of pages) other.active = false
  pages.push(page)
  return page
}

beforeEach(() => {
  jest.useRealTimers()
  jest.clearAllMocks()
  pages = []
  nextPage = 0
  resetSharedLocalBrowserForTests({ createSessionId: () => "shared-1" })
  client.onEvent.mockImplementation(async (callback) => {
    emit = callback
    return jest.fn()
  })
  client.createSession.mockImplementation(async ({ id }) => {
    addPage("about:blank", true)
    return { id }
  })
  client.closeSession.mockResolvedValue(undefined)
  client.subscribeFrames.mockResolvedValue(unsubscribeFrames)
  client.rpc.mockImplementation(async (op: string, payload: Record<string, unknown>) => {
    switch (op) {
      case "browser.pages":
        return summary()
      case "browser.page.create":
        return { ...addPage("about:blank", payload.activate !== false) }
      case "browser.page.activate":
        for (const page of pages) page.active = page.id === payload.pageId
        return undefined
      case "browser.page.close":
        pages = pages.filter((page) => page.id !== payload.pageId)
        return undefined
      default:
        return { ok: true }
    }
  })
})

describe("owners", () => {
  it("names a conversation's pages and reads the conversation back", () => {
    expect(chatPageOwner("s1")).toBe("chat:s1")
    expect(chatSessionOfOwner("chat:s1")).toBe("s1")
    expect(chatSessionOfOwner("pane:x")).toBeNull()
  })
})

describe("ensureSharedLocalBrowser", () => {
  it("creates one headless local session for every concurrent caller", async () => {
    const [a, b] = await Promise.all([ensureSharedLocalBrowser(), ensureSharedLocalBrowser()])
    expect(a).toBe("shared-1")
    expect(b).toBe("shared-1")
    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(client.createSession).toHaveBeenCalledWith({
      id: "shared-1",
      kind: "local",
      headless: true,
      allowFileUrls: true,
    })
    expect(sharedLocalBrowserStore.getState()).toMatchObject({
      status: "ready",
      pages: [{ id: "p1" }],
    })
  })

  it("reports the runtime's error code when the session cannot be created", async () => {
    client.createSession.mockRejectedValueOnce("chromium_not_installed: install it first")
    await expect(ensureSharedLocalBrowser()).rejects.toMatchObject({
      code: "chromium_not_installed",
    })
    expect(sharedLocalBrowserStore.getState()).toMatchObject({
      status: "failed",
      sessionId: null,
      error: "chromium_not_installed: install it first",
    })
  })
})

describe("openOwnedPage", () => {
  it("hands the session's first blank page to the first owner, then opens behind", async () => {
    const first = await openOwnedPage("chat:a", { tag: "t1", activate: true })
    expect(first.id).toBe("p1")
    expect(client.rpc).not.toHaveBeenCalledWith("browser.page.create", expect.anything())

    const second = await openOwnedPage("chat:b", { tag: "t2" })
    expect(client.rpc).toHaveBeenCalledWith("browser.page.create", {
      sessionId: "shared-1",
      activate: false,
    })
    // Listed at once, before the runtime's debounced page list arrives.
    expect(taggedPage("chat:b", "t2")?.id).toBe(second.id)
    expect(ownerPages("chat:a").map((page) => page.id)).toEqual(["p1"])
    expect(sharedLocalBrowserStore.getState().focus).toEqual({
      "chat:a": "p1",
      "chat:b": second.id,
    })
  })

  it("refuses an owner past its page budget", async () => {
    for (let index = 0; index < MAX_PAGES_PER_OWNER; index += 1) await openOwnedPage("chat:a")
    await expect(openOwnedPage("chat:a")).rejects.toMatchObject({
      code: "browser_page_quota_exceeded",
    })
  })
})

describe("page list", () => {
  it("gives a popup to its opener's owner, and a stray to the owner in front", async () => {
    const front = await openOwnedPage("chat:a", { activate: true })
    const behind = await openOwnedPage("chat:b")
    addPage("https://popup.test/", false, behind.id)
    addPage("https://stray.test/")
    pagesChanged()
    expect(ownerPages("chat:b").map((page) => page.url)).toEqual([
      "about:blank",
      "https://popup.test/",
    ])
    expect(ownerPages("chat:a").map((page) => page.id)).toEqual([front.id, "p4"])
    expect(sharedLocalBrowserStore.getState().owned.p3).toEqual({ owner: "chat:b", tag: null })
  })

  it("moves an owner's focus to a page it still has when its focus closes", async () => {
    const first = await openOwnedPage("chat:a")
    const second = await openOwnedPage("chat:a")
    expect(sharedLocalBrowserStore.getState().focus["chat:a"]).toBe(second.id)
    pages = pages.filter((page) => page.id !== second.id)
    pagesChanged()
    expect(sharedLocalBrowserStore.getState().focus["chat:a"]).toBe(first.id)
  })

  it("keeps a dialog against the page that raised it until it is answered", async () => {
    const page = await openOwnedPage("chat:a")
    emit({
      type: "dialog.opened",
      sessionId: "shared-1",
      pageId: page.id,
      dialog: { type: "confirm", message: "Sure?" },
    })
    expect(sharedLocalBrowserStore.getState().dialogs[page.id]).toEqual({
      type: "confirm",
      message: "Sure?",
    })
    await answerSharedDialog(page.id, { accept: true })
    expect(sharedLocalBrowserStore.getState().dialogs).toEqual({})
    expect(client.rpc).toHaveBeenCalledWith("browser.dialog.handle", {
      sessionId: "shared-1",
      pageId: page.id,
      accept: true,
    })
  })

  it("forgets everything when the runtime closes the session", async () => {
    await openOwnedPage("chat:a")
    emit({ type: "session.closed", sessionId: "shared-1" })
    expect(sharedLocalBrowserStore.getState()).toMatchObject({
      sessionId: null,
      status: "idle",
      owned: {},
    })
  })

  it("ignores another session's events", async () => {
    await openOwnedPage("chat:a")
    emit({ type: "session.closed", sessionId: "other" })
    expect(sharedLocalBrowserStore.getState().sessionId).toBe("shared-1")
  })
})

describe("releaseOwner", () => {
  it("closes the owner's pages and leaves the others and the session", async () => {
    const a = await openOwnedPage("chat:a")
    const b = await openOwnedPage("chat:b")
    await releaseOwner("chat:a")
    expect(client.rpc).toHaveBeenCalledWith("browser.page.close", {
      sessionId: "shared-1",
      pageId: a.id,
    })
    expect(client.rpc).not.toHaveBeenCalledWith("browser.page.close", {
      sessionId: "shared-1",
      pageId: b.id,
    })
    expect(sharedLocalBrowserStore.getState().focus).toEqual({ "chat:b": b.id })
    expect(client.closeSession).not.toHaveBeenCalled()
  })
})

describe("ownedPageEngine", () => {
  it("acts on the owner's focus page, opening one behind the user's on first use", async () => {
    const userPage = await openOwnedPage("chat:a", { activate: true })
    const engine = ownedPageEngine("chat:b")
    expect(engine.backend).toBe("local-chromium")
    await engine.navigate("https://b.test/")
    const focus = sharedLocalBrowserStore.getState().focus["chat:b"]
    expect(focus).not.toBe(userPage.id)
    expect(client.rpc).toHaveBeenCalledWith("browser.navigate", {
      sessionId: "shared-1",
      pageId: focus,
      url: "https://b.test/",
    })
    expect(pages.find((page) => page.active)?.id).toBe(userPage.id)
  })

  it("lists, switches and closes only the owner's own pages", async () => {
    const other = await openOwnedPage("chat:a")
    const engine = ownedPageEngine("chat:b")
    const created = (await engine.createPage("https://one.test/")) as BrowserPageSummary
    await engine.createPage()
    expect((await engine.listPages()).map((page) => page.id)).toEqual(
      ownerPages("chat:b").map((page) => page.id)
    )
    await engine.activatePage(created.id)
    expect(sharedLocalBrowserStore.getState().focus["chat:b"]).toBe(created.id)
    // Switching moves the agent's focus, never the page in front.
    expect(client.rpc).not.toHaveBeenCalledWith("browser.page.activate", expect.anything())
    await expect(engine.activatePage(other.id)).rejects.toMatchObject({
      code: "browser_page_not_found",
    })
    await expect(engine.closePage(other.id)).rejects.toMatchObject({
      code: "browser_page_not_found",
    })
  })

  it("reuses the owner's last page when it has no focus yet", async () => {
    const page = await openOwnedPage("chat:a")
    sharedLocalBrowserStore.setState({ focus: {} })
    expect(await ensureOwnerFocusPage("chat:a")).toBe(page.id)
  })
})

describe("ensureTaggedPage", () => {
  it("opens one page per tag however many ask at once", async () => {
    await openOwnedPage("chat:z")
    const [a, b] = await Promise.all([
      ensureTaggedPage("chat:a", "t1"),
      ensureTaggedPage("chat:a", "t1"),
    ])
    expect(a.page.id).toBe(b.page.id)
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect(await ensureTaggedPage("chat:a", "t1")).toEqual({ page: a.page, created: false })
  })

  it("gives an agent the tab on screen for its first page", async () => {
    await openOwnedPage("chat:z")
    setFocusPageTagResolver((owner) => (owner === "chat:a" ? "shown" : null))
    const pageId = await ensureOwnerFocusPage("chat:a")
    expect(taggedPage("chat:a", "shown")?.id).toBe(pageId)
    // Without a tab to take, it opens an untagged page of its own.
    const other = await ensureOwnerFocusPage("chat:b")
    expect(sharedLocalBrowserStore.getState().owned[other]).toEqual({ owner: "chat:b", tag: null })
  })
})

describe("frames and idle close", () => {
  it("subscribes the runtime once for every listener and stops with the last", async () => {
    await ensureSharedLocalBrowser()
    const one = jest.fn()
    const two = jest.fn()
    const offOne = subscribeSharedFrames(one)
    const offTwo = subscribeSharedFrames(two)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.subscribeFrames).toHaveBeenCalledTimes(1)
    const deliver = client.subscribeFrames.mock.calls[0][1] as (bytes: Uint8Array) => void
    deliver(new Uint8Array([1]))
    expect(one).toHaveBeenCalled()
    expect(two).toHaveBeenCalled()
    offOne()
    offTwo()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unsubscribeFrames).toHaveBeenCalledTimes(1)
  })

  it("closes a session nobody holds a page in or watches", async () => {
    jest.useFakeTimers()
    await openOwnedPage("chat:a")
    await releaseOwner("chat:a")
    pagesChanged()
    jest.advanceTimersByTime(SHARED_BROWSER_IDLE_CLOSE_MS)
    expect(client.closeSession).toHaveBeenCalledWith("shared-1")
    expect(sharedLocalBrowserStore.getState().sessionId).toBeNull()
  })

  it("keeps a session that still holds an owned page", async () => {
    jest.useFakeTimers()
    await openOwnedPage("chat:a")
    pagesChanged()
    jest.advanceTimersByTime(SHARED_BROWSER_IDLE_CLOSE_MS * 2)
    expect(client.closeSession).not.toHaveBeenCalled()
  })
})
