import { runGithubPoll, type GhTable, type PollContext } from "./github-poll"
import type { GhRepoEntry, NormalizedGhEvent } from "@/lib/github/types"

function inMemoryTable<T>(primaryKey: keyof T): GhTable<T> {
  const map = new Map<unknown, T>()
  return {
    async toArray() {
      return Array.from(map.values())
    },
    async get(key: unknown) {
      return map.get(key)
    },
    async put(row: T) {
      map.set(row[primaryKey], row)
    },
    async bulkPut(rows: T[]) {
      for (const r of rows) map.set(r[primaryKey], r)
    },
  }
}

function makeRepo(overrides: Partial<GhRepoEntry> = {}): GhRepoEntry {
  return {
    fullName: "octocat/hello-world",
    credentialMode: "pat",
    patKeyringId: "kr",
    pushTarget: { kind: "source-branch" },
    worktreeMode: "local",
    triggerMode: "polling",
    createdAt: 0,
    ...overrides,
  }
}

function fakeOctokit(response: {
  status: number
  headers?: Record<string, string>
  data?: unknown[]
}) {
  return {
    request: jest.fn(async () => ({
      status: response.status,
      headers: response.headers ?? {},
      data: response.data ?? [],
    })),
  } as unknown as import("@octokit/core").Octokit
}

describe("runGithubPoll", () => {
  it("skips repos that are not in polling mode", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo({ triggerMode: "webhook" }))
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")

    const ctx: PollContext = {
      reposTable,
      eventsTable,
      octokitFor: jest.fn(),
    }
    const results = await runGithubPoll(ctx)
    expect(results).toEqual([])
    expect(ctx.octokitFor).not.toHaveBeenCalled()
  })

  it("returns notModified=true on 304 and does not write events", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo({ pollEtag: "etag-old" }))
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")

    const octokit = fakeOctokit({ status: 304 })
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
    })
    expect(results).toHaveLength(1)
    expect(results[0].notModified).toBe(true)
    expect(await eventsTable.toArray()).toHaveLength(0)
  })

  it("normalizes a PullRequestEvent payload + dedupes against the events table", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo())
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")

    const octokit = fakeOctokit({
      status: 200,
      headers: { etag: "etag-new" },
      data: [
        {
          type: "PullRequestEvent",
          actor: { login: "alice" },
          created_at: "2026-05-12T10:00:00Z",
          payload: {
            action: "opened",
            pull_request: {
              number: 42,
              user: { login: "alice" },
              head: { sha: "abc", ref: "feat/x" },
              base: { ref: "main" },
              state: "open",
              updated_at: "2026-05-12T10:00:00Z",
            },
          },
        },
      ],
    })
    const onEvent = jest.fn()
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
      onEvent,
    })
    expect(results[0].newEventCount).toBe(1)
    const stored = await eventsTable.toArray()
    expect(stored).toHaveLength(1)
    expect(stored[0].kind).toBe("pull_request.opened")
    expect(onEvent).toHaveBeenCalledTimes(1)

    // Re-poll with the same delivery → dedup.
    const results2 = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
      onEvent,
    })
    expect(results2[0].newEventCount).toBe(0)
    expect(onEvent).toHaveBeenCalledTimes(1) // not called again
  })

  it("persists the new etag for the next cycle", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo())
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")
    const octokit = fakeOctokit({
      status: 200,
      headers: { etag: "etag-new" },
      data: [],
    })
    await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
    })
    const persisted = (await reposTable.toArray())[0]
    expect(persisted.pollEtag).toBe("etag-new")
    expect(persisted.lastDeliveryAt).toBeGreaterThan(0)
  })

  it("ignores Issues that are actually PRs (payload.issue.pull_request set)", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo())
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")
    const octokit = fakeOctokit({
      status: 200,
      data: [
        {
          type: "IssuesEvent",
          payload: {
            action: "opened",
            issue: {
              number: 99,
              user: { login: "x" },
              pull_request: {},
              state: "open",
              updated_at: "",
            },
          },
        },
      ],
    })
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
    })
    expect(results[0].newEventCount).toBe(0)
  })

  it("logs and records errored=true when Octokit rejects", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo())
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")
    const error = jest.fn()
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => {
        throw new Error("boom")
      },
      logger: { error },
    })
    expect(results[0]).toMatchObject({ errored: true, newEventCount: 0 })
    expect(error).toHaveBeenCalled()
  })

  it("rejects malformed repo full names early", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo({ fullName: "no-slash" }))
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")
    const error = jest.fn()
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => fakeOctokit({ status: 200 }),
      logger: { error },
    })
    expect(results[0].errored).toBe(true)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/bad repo full name/))
  })

  it("maps IssueCommentEvent to issue_comment.created", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo())
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")
    const octokit = fakeOctokit({
      status: 200,
      data: [
        {
          type: "IssueCommentEvent",
          payload: { action: "created", issue: { number: 5, state: "open", updated_at: "" } },
        },
      ],
    })
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
    })
    expect(results[0].newEventCount).toBe(1)
  })

  it("maps ReleaseEvent.published", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo())
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")
    const octokit = fakeOctokit({
      status: 200,
      data: [
        {
          type: "ReleaseEvent",
          payload: {
            action: "published",
            release: { tag_name: "v1.0.0", name: "First", draft: false },
          },
        },
      ],
    })
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
    })
    expect(results[0].newEventCount).toBe(1)
  })

  it("ignores unsupported event types", async () => {
    const reposTable = inMemoryTable<GhRepoEntry>("fullName")
    await reposTable.put(makeRepo())
    const eventsTable = inMemoryTable<NormalizedGhEvent>("deliveryId")
    const octokit = fakeOctokit({
      status: 200,
      data: [{ type: "WatchEvent", payload: { action: "started" } }],
    })
    const results = await runGithubPoll({
      reposTable,
      eventsTable,
      octokitFor: async () => octokit,
    })
    expect(results[0].newEventCount).toBe(0)
  })
})
