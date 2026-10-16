import { AgentOperationError } from "./protocol"
import {
  PENDING_SITE_QUESTIONS_KEY,
  SitePermissions,
  originOf,
  type SiteQuestion,
} from "./site-permissions"
import { memoryStorageArea } from "./storage-area"

function harness() {
  const local = memoryStorageArea()
  const session = memoryStorageArea()
  const once = new Set<string>()
  const asked: SiteQuestion[] = []
  let id = 0
  let clock = 1_000
  const permissions = new SitePermissions({
    local,
    session,
    now: () => clock,
    newId: () => `q${++id}`,
    onQuestion: (question) => asked.push(question),
    hasOnce: async (s, origin) => once.has(`${s}|${origin}`),
    grantOnce: async (s, origin) => {
      once.add(`${s}|${origin}`)
    },
  })
  return {
    permissions,
    session,
    asked,
    once,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("originOf", () => {
  it("accepts http(s) and refuses everything else", () => {
    expect(originOf("https://a.example/x?y")).toBe("https://a.example")
    for (const url of ["chrome://settings", "file:///etc/hosts", "not a url"]) {
      expect(() => originOf(url)).toThrow(AgentOperationError)
    }
  })
})

describe("SitePermissions", () => {
  it("passes a site always allowed, and refuses one never allowed, without asking", async () => {
    const { permissions, asked } = harness()
    await permissions.setDecision("https://a.example", "always")
    await permissions.setDecision("https://b.example", "never")
    await expect(
      permissions.ensureAllowed("s", "https://a.example/page", "snapshot", 5_000)
    ).resolves.toBeUndefined()
    await expect(
      permissions.ensureAllowed("s", "https://b.example/", "snapshot", 5_000)
    ).rejects.toMatchObject({ code: "browser_site_blocked" })
    expect(asked).toEqual([])
  })

  it("asks once and proceeds when allowed once for this conversation", async () => {
    const { permissions, asked } = harness()
    const pending = permissions.ensureAllowed("s", "https://c.example/p", "navigate", 60_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toHaveLength(1)
    expect(await permissions.questions()).toHaveLength(1)
    await permissions.answer(asked[0]!.id, "once")
    await expect(pending).resolves.toBeUndefined()
    expect(await permissions.questions()).toEqual([])
    // The once-grant covers later operations in the same conversation only.
    await expect(
      permissions.ensureAllowed("s", "https://c.example/q", "act", 60_000)
    ).resolves.toBeUndefined()
  })

  it("joins a question already asked instead of asking twice", async () => {
    const { permissions, asked } = harness()
    const first = permissions.ensureAllowed("s", "https://d.example/", "snapshot", 60_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = permissions.ensureAllowed("s", "https://d.example/x", "act", 60_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toHaveLength(1)
    await permissions.answer(asked[0]!.id, "always")
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect((await permissions.decisions())["https://d.example"]).toBe("always")
  })

  it("refuses when the person says never", async () => {
    const { permissions, asked } = harness()
    const pending = permissions.ensureAllowed("s", "https://e.example/", "act", 60_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await permissions.answer(asked[0]!.id, "never")
    await expect(pending).rejects.toMatchObject({ code: "browser_site_blocked" })
  })

  it("times out into a refusal the agent can relay", async () => {
    jest.useFakeTimers()
    const { permissions } = harness()
    const pending = permissions.ensureAllowed("s", "https://f.example/", "act", 1_500)
    const settled = pending.catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(600)
    expect(await settled).toMatchObject({ code: "browser_site_permission_required" })
    jest.useRealTimers()
  })

  it("drops a conversation's questions when it ends", async () => {
    const { permissions, session } = harness()
    void permissions.ensureAllowed("s", "https://g.example/", "act", 60_000).catch(() => undefined)
    void permissions.ensureAllowed("t", "https://g.example/", "act", 60_000).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await permissions.dropQuestions("s")
    const left = (await session.get<SiteQuestion[]>(PENDING_SITE_QUESTIONS_KEY)) ?? []
    expect(left.map((question) => question.session)).toEqual(["t"])
  })
})
