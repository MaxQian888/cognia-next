import { createAgentRuntime, isAgentControlMessage, isAgentOpenTabMessage } from "./agent-runtime"
import type { AgentBrowser, AgentTab } from "./executor"
import { mainEvaluate, pageActingBar } from "./page-functions"
import { AGENT_SESSIONS_KEY } from "./sessions"
import { PENDING_SITE_QUESTIONS_KEY, SITE_DECISIONS_KEY } from "./site-permissions"
import { memoryStorageArea } from "./storage-area"

function harness() {
  let clock = 1_000
  const tabs = new Map<number, AgentTab>()
  let nextTab = 20
  const bars: { tabId: number; state: unknown }[] = []
  const cancelled: string[] = []
  const grouped: number[][] = []
  const browser = {
    getTab: async (id: number) => tabs.get(id) ?? null,
    createTab: async ({
      url,
      windowId,
      active,
    }: {
      url: string
      windowId?: number
      active: boolean
    }) => {
      const tab: AgentTab = {
        id: ++nextTab,
        windowId: windowId ?? 1,
        url,
        title: "",
        status: "complete",
        active,
        groupId: -1,
      }
      tabs.set(tab.id, tab)
      return tab
    },
    group: async (ids: number[], groupId: number | null) => {
      grouped.push(ids)
      return groupId ?? 4
    },
    styleGroup: async () => undefined,
    updateTab: jest.fn(async () => undefined),
    run: async (tabId: number, _world: string, func: unknown, args: unknown[]) => {
      if (func === pageActingBar) bars.push({ tabId, state: args[0] })
      return true
    },
    message: (key: string) => key,
  } as unknown as AgentBrowser
  const local = memoryStorageArea()
  const session = memoryStorageArea()
  const runtime = createAgentRuntime({
    browser,
    local,
    session,
    now: () => clock,
    sleep: async () => undefined,
    newId: () => "q1",
    onQuestion: () => undefined,
    cancelConversation: async (id) => {
      cancelled.push(id)
    },
  })
  const seed = async (tabIds: number[]) =>
    runtime.sessions.updateSession("s1", 1_000, (s) => ({
      ...s,
      tabIds,
      ownedTabIds: [],
      activeTabId: tabIds[0] ?? null,
      windowId: 1,
      groupId: 4,
    }))
  return {
    runtime,
    browser,
    bars,
    cancelled,
    grouped,
    tabs,
    local,
    session,
    seed,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("message guards", () => {
  it("accept only well-formed messages", () => {
    expect(
      isAgentControlMessage({ kind: "cognia-agent-control", session: "s", action: "stop" })
    ).toBe(true)
    expect(
      isAgentControlMessage({ kind: "cognia-agent-control", session: "s", action: "delete" })
    ).toBe(false)
    expect(isAgentControlMessage(null)).toBe(false)
    expect(isAgentOpenTabMessage({ kind: "cognia-agent-open-tab", url: "https://a" })).toBe(true)
    expect(isAgentOpenTabMessage({ kind: "cognia-agent-open-tab" })).toBe(false)
  })
})

describe("createAgentRuntime", () => {
  it.each(["stop", "takeover"] as const)(
    "applies %s immediately while an older Resume is painting",
    async (action) => {
      const h = harness()
      await h.seed([5])
      await h.runtime.control(
        { kind: "cognia-agent-control", session: "s1", action: "takeover" },
        5
      )
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      jest.spyOn(h.browser, "run").mockImplementationOnce(async () => {
        entered()
        await held
        return true as never
      })
      const resume = h.runtime.control(
        { kind: "cognia-agent-control", session: "s1", action: "resume" },
        5
      )
      await waiting
      const pause = h.runtime.control({ kind: "cognia-agent-control", session: "s1", action }, 5)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const result = await h.runtime
        .execute("create_page", { session: "s1" }, 5_000)
        .catch((error: unknown) => error)
      release()
      await Promise.all([resume, pause])
      expect(result).toMatchObject({ code: "browser_user_takeover" })
      expect(h.tabs.size).toBe(0)
    }
  )
  it("refuses a new native call when an asynchronous state read exhausts the deadline", async () => {
    const h = harness()
    const get = h.session.get.bind(h.session)
    jest.spyOn(h.session, "get").mockImplementationOnce(async (key) => {
      h.advance(2_000)
      return get(key)
    })
    await expect(h.runtime.execute("create_page", { session: "s1" }, 1_000)).rejects.toMatchObject({
      code: "browser_operation_timeout",
    })
    expect(h.tabs.size).toBe(0)
  })
  it("does not let an in-flight release delete a newer pause", async () => {
    const h = harness()
    await h.seed([5])
    await h.runtime.sessions.updateSession("s1", 1_000, (s) => ({ ...s, ownedTabIds: [5] }))
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    jest.spyOn(h.browser, "run").mockImplementationOnce(async () => {
      entered()
      await held
      return true as never
    })
    const result = h.runtime
      .execute("release", { session: "s1" }, 5_000)
      .catch((error: unknown) => error)
    await waiting
    await h.runtime.control({ kind: "cognia-agent-control", session: "s1", action: "takeover" }, 5)
    release()
    expect(await result).toMatchObject({ code: "browser_user_takeover" })
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ takeover: true })
  })

  it("finishes old Stop cleanup before applying Resume and accepting fresh questions", async () => {
    const h = harness()
    await h.seed([5])
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    jest.spyOn(h.browser, "run").mockImplementationOnce(async () => {
      entered()
      await held
      return true as never
    })
    const stop = h.runtime.control(
      { kind: "cognia-agent-control", session: "s1", action: "stop" },
      5
    )
    await waiting
    const resume = h.runtime.control(
      { kind: "cognia-agent-control", session: "s1", action: "resume" },
      5
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ takeover: true })
    release()
    await Promise.all([stop, resume])
    const pending = h.runtime.permissions.ensureAllowed("s1", "https://new.test", "navigate", 5_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await h.runtime.permissions.questions()).toHaveLength(1)
    await h.runtime.permissions.answer("q1", "once")
    await expect(pending).resolves.toBeUndefined()
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ takeover: false })
  })
  it("honours a control only from a tab the conversation holds", async () => {
    const h = harness()
    await h.seed([5])
    const message = {
      kind: "cognia-agent-control" as const,
      session: "s1",
      action: "takeover" as const,
    }
    await expect(h.runtime.control(message, 6)).resolves.toBe(false)
    await expect(h.runtime.control(message, undefined)).resolves.toBe(false)
    await expect(h.runtime.control({ ...message, session: "other" }, 5)).resolves.toBe(false)
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ takeover: false })
  })

  it("takes over and resumes, repainting the bar and dropping open questions", async () => {
    const h = harness()
    await h.seed([5, 6])
    await h.session.set(PENDING_SITE_QUESTIONS_KEY, [
      { id: "q", session: "s1", origin: "https://a.test", operation: "act", askedAt: 1 },
    ])
    await h.runtime.control({ kind: "cognia-agent-control", session: "s1", action: "takeover" }, 6)
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ takeover: true })
    expect(await h.session.get(PENDING_SITE_QUESTIONS_KEY)).toEqual([])
    expect(
      h.bars.map((bar) => [bar.tabId, (bar.state as { takenOver: boolean }).takenOver])
    ).toEqual([
      [5, true],
      [6, true],
    ])
    await h.runtime.control({ kind: "cognia-agent-control", session: "s1", action: "resume" }, 5)
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ takeover: false })
    expect((h.bars.at(-1)?.state as { takenOver: boolean }).takenOver).toBe(false)
  })

  it("stops the task and keeps a paused bar so only the person can resume", async () => {
    const h = harness()
    await h.seed([5])
    await h.runtime.control({ kind: "cognia-agent-control", session: "s1", action: "stop" }, 5)
    expect(h.bars).toEqual([{ tabId: 5, state: expect.objectContaining({ takenOver: true }) }])
    expect(h.cancelled).toEqual(["s1"])
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ tabIds: [5], takeover: true })
  })

  it.each(["stop", "takeover"] as const)(
    "cancels an operation already waiting for site permission on %s",
    async (action) => {
      const h = harness()
      await h.seed([5])
      h.tabs.set(5, {
        id: 5,
        windowId: 1,
        url: "https://a.test",
        title: "",
        status: "complete",
        active: true,
        groupId: 4,
      })
      const run = jest.spyOn(h.browser, "run")
      const pending = h.runtime
        .execute("evaluate", { session: "s1", expression: "effect()" }, 5_000)
        .catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await h.runtime.permissions.questions()).toHaveLength(1)
      await h.runtime.control({ kind: "cognia-agent-control", session: "s1", action }, 5)
      expect(await pending).toMatchObject({
        code: action === "stop" ? "browser_operation_cancelled" : "browser_user_takeover",
      })
      await h.runtime.permissions.answer("q1", "once")
      expect(run.mock.calls.some(([, , func]) => func === mainEvaluate)).toBe(false)
      expect(await h.runtime.permissions.questions()).toEqual([])
    }
  )

  it.each(["stop", "takeover"] as const)(
    "refuses new operations during %s cleanup and until an explicit resume",
    async (action) => {
      const h = harness()
      await h.seed([5])
      h.tabs.set(5, {
        id: 5,
        windowId: 1,
        url: "https://a.test",
        title: "",
        status: "complete",
        active: true,
        groupId: 4,
      })
      await h.runtime.permissions.setDecision("https://a.test", "always")
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const original = h.session.set.bind(h.session)
      jest.spyOn(h.session, "set").mockImplementationOnce(async (key, value) => {
        expect(key).toBe(AGENT_SESSIONS_KEY)
        entered()
        await held
        await original(key, value)
      })
      const control = h.runtime.control({ kind: "cognia-agent-control", session: "s1", action }, 5)
      await waiting
      await expect(
        h.runtime.execute("navigate", { session: "s1", url: "https://a.test/next" }, 5_000)
      ).rejects.toMatchObject({ code: "browser_user_takeover" })
      expect(h.browser.updateTab).not.toHaveBeenCalled()
      release()
      await control
      await expect(
        h.runtime.execute("navigate", { session: "s1", url: "https://a.test/next" }, 5_000)
      ).rejects.toMatchObject({ code: "browser_user_takeover" })
      await h.runtime.control({ kind: "cognia-agent-control", session: "s1", action: "resume" }, 5)
      await expect(
        h.runtime.execute("navigate", { session: "s1", url: "https://a.test/next" }, 5_000)
      ).resolves.toMatchObject({ ok: true })
      expect(h.browser.updateTab).toHaveBeenCalledTimes(1)
    }
  )

  it("opens a page's new-tab link in the background, inside the conversation", async () => {
    const h = harness()
    await h.seed([5])
    await expect(
      h.runtime.openTab({ kind: "cognia-agent-open-tab", url: "https://b.test/x" }, 5)
    ).resolves.toBe(true)
    const opened = [...h.tabs.values()][0]!
    expect(opened).toMatchObject({ url: "https://b.test/x", active: false })
    expect(await h.runtime.sessions.get("s1")).toMatchObject({
      tabIds: [5, opened.id],
      ownedTabIds: [opened.id],
      activeTabId: 5,
    })
    expect(h.grouped).toEqual([[opened.id]])
  })

  it("ignores new-tab links from tabs no conversation holds, and non-web addresses", async () => {
    const h = harness()
    await h.seed([5])
    await expect(
      h.runtime.openTab({ kind: "cognia-agent-open-tab", url: "https://b.test" }, 9)
    ).resolves.toBe(false)
    await expect(
      h.runtime.openTab({ kind: "cognia-agent-open-tab", url: "javascript:alert(1)" }, 5)
    ).resolves.toBe(false)
    await expect(
      h.runtime.openTab({ kind: "cognia-agent-open-tab", url: "not a url" }, 5)
    ).resolves.toBe(false)
    expect(h.tabs.size).toBe(0)
  })

  it("forgets a closed tab and reports whether any conversation holds tabs", async () => {
    const h = harness()
    expect(await h.runtime.hasSessions()).toBe(false)
    await h.seed([5, 6])
    await h.runtime.tabRemoved(5)
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ tabIds: [6], activeTabId: 6 })
    expect(await h.runtime.hasSessions()).toBe(true)
  })

  it("grants once per conversation through the session store", async () => {
    const h = harness()
    await h.seed([5])
    h.tabs.set(5, {
      id: 5,
      windowId: 1,
      url: "https://a.test/",
      title: "",
      status: "complete",
      active: true,
      groupId: 4,
    })
    await h.local.set(SITE_DECISIONS_KEY, {})
    const pending = h.runtime.permissions.ensureAllowed(
      "s1",
      "https://a.test/",
      "act",
      1_000 + 60_000
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await h.runtime.permissions.answer("q1", "once")
    await expect(pending).resolves.toBeUndefined()
    expect(await h.runtime.sessions.get("s1")).toMatchObject({ onceOrigins: ["https://a.test"] })
  })
})
