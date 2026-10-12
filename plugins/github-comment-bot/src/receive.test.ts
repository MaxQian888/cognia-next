import { GithubRequestError } from "@cognia/github-bot-kit"

import {
  AUTHOR,
  BOT,
  fixture,
  issueComment,
  NOW,
  REPOSITORY,
  TRIGGER,
} from "./comment-bot.test-helpers"
import { readerFor } from "./identity"
import { candidateFromEvent, considerCandidate, type Candidate } from "./receive"

const repository = { id: 4242, full_name: REPOSITORY }

function webhook(type: string, body: string, over: Record<string, unknown> = {}) {
  const comment = issueComment(11, body)
  return {
    type,
    payload: {
      repository,
      sender: AUTHOR,
      comment,
      issue: { number: 7 },
      ...over,
    },
  }
}

function setup(over: Parameters<typeof fixture>[0] = {}) {
  const f = fixture({ triggerId: "github", source: "integration", ...over })
  const env = {
    reader: readerFor(f.context, f.run, f.config, f.now),
    identity: { id: BOT.id, login: BOT.login, isApp: true },
    trigger: TRIGGER,
    watermark: NOW - 3_600_000,
    now: f.now,
  }
  const consider = (candidate: Candidate | undefined) =>
    considerCandidate(f.context, f.run, f.config, env, candidate!)
  return { f, env, consider }
}

const event = (body: string, type = "issue_comment.created", over = {}) =>
  candidateFromEvent(webhook(type, body, over), { repository: REPOSITORY })

it("queues an authorized ask as its own command resource, scoped to the repository", async () => {
  const { f, consider } = setup()
  expect(await consider(event("@cognia-bot ask why does it crash?"))).toBe("queued")
  expect(f.mocks.enqueue).toHaveBeenCalledWith("run", {
    triggerId: "execute",
    eventId: `gh-cmd:4242:issue_comment:11:${new Date(NOW - 60_000).toISOString()}`,
    type: "github-command.execute",
    payload: expect.objectContaining({
      verb: "ask",
      request: "why does it crash?",
      threadKind: "issue",
      revision: new Date(NOW - 60_000).toISOString(),
    }),
    resource: {
      kind: "github_command",
      id: "acme/widgets#7:issue_comment:11",
      scope: "4242",
      url: expect.stringContaining("issuecomment-11"),
    },
  })
  // The same version again is already handled.
  expect(await consider(event("@cognia-bot ask why does it crash?"))).toBe("ignored")
  expect(f.mocks.enqueue).toHaveBeenCalledTimes(1)
})

it("ignores its own output, its own account, machines, and comments not addressed to it", async () => {
  const { f, consider } = setup()
  expect(await consider(event("@cognia-bot ask\n\n<!-- cognia-command:v1:a-1 -->"))).toBe("ignored")
  expect(
    await consider(
      event("@cognia-bot ask", "issue_comment.created", {
        comment: issueComment(11, "@cognia-bot ask", { user: BOT }),
      })
    )
  ).toBe("ignored")
  expect(
    await consider(
      event("@cognia-bot ask", "issue_comment.created", {
        comment: issueComment(12, "@cognia-bot ask", {
          user: { id: 5, login: "ci[bot]", type: "Bot" },
        }),
      })
    )
  ).toBe("ignored")
  expect(await consider(event("> @cognia-bot ask\n\nthanks"))).toBe("ignored")
  expect(await consider(event("Please ask @cognia-bot later"))).toBe("ignored")
  expect(f.mocks.enqueue).not.toHaveBeenCalled()
})

it("never runs history from before activation, and refuses unauthorized authors silently", async () => {
  const { f, consider } = setup()
  const old = new Date(NOW - 2 * 3_600_000).toISOString()
  expect(
    await consider(
      event("@cognia-bot ask", "issue_comment.created", {
        comment: issueComment(11, "@cognia-bot ask", {
          created_at: old,
          updated_at: new Date(NOW).toISOString(),
        }),
      })
    )
  ).toBe("ignored")
  f.github.permissions.set(AUTHOR.login, { permission: "read", id: AUTHOR.id })
  expect(
    await consider(
      event("@cognia-bot ask", "issue_comment.created", {
        comment: issueComment(12, "@cognia-bot ask"),
      })
    )
  ).toBe("denied")
  expect(f.mocks.enqueue).not.toHaveBeenCalled()
  expect(f.run.log).toHaveBeenCalledWith("warn", "Command from an unauthorized author ignored", {
    reason: "insufficient_permission",
    thread: 7,
  })
})

it("retries rather than guessing when the permission check cannot be made", async () => {
  const { f, consider } = setup()
  f.github.overrides.set(`/collaborators/${AUTHOR.login}/permission`, undefined)
  f.mocks.request.mockImplementation(async (_b: unknown, url: string) => {
    if (url.includes("/permission")) throw new GithubRequestError(502)
    throw new Error(`unexpected ${url}`)
  })
  await expect(consider(event("@cognia-bot ask"))).rejects.toThrow("Could not verify")
})

it("replies to expired commands in automatic mode only", async () => {
  const stale = new Date(NOW - 30 * 3_600_000).toISOString()
  const stalePayload = {
    comment: issueComment(11, "@cognia-bot ask", {
      created_at: new Date(NOW - 3_000_000).toISOString(),
      updated_at: stale,
    }),
  }
  const auto = setup()
  // Activation predates the comment's creation; the version is older than 24 h.
  auto.env.watermark = NOW - 31 * 3_600_000
  stalePayload.comment.created_at = new Date(NOW - 30.5 * 3_600_000).toISOString()
  expect(await auto.consider(event("@cognia-bot ask", "issue_comment.created", stalePayload))).toBe(
    "expired"
  )
  expect(auto.f.mocks.enqueue).toHaveBeenCalledWith(
    "run",
    expect.objectContaining({
      triggerId: "reply",
      payload: expect.objectContaining({ reply: { kind: "expired" } }),
    })
  )
  const manual = setup({ config: { publicationMode: "approval" } })
  manual.env.watermark = NOW - 31 * 3_600_000
  expect(
    await manual.consider(event("@cognia-bot ask", "issue_comment.created", stalePayload))
  ).toBe("expired")
  expect(manual.f.mocks.enqueue).not.toHaveBeenCalled()
})

it.each([
  ["@cognia-bot", { kind: "help" }],
  ["@cognia-bot help", { kind: "help" }],
  ["@cognia-bot fix it", { kind: "not_enabled", verb: "fix" }],
  ["@cognia-bot retry 0a1b2c3d", { kind: "not_enabled", verb: "retry" }],
  ["@cognia-bot status", { kind: "status" }],
  ["@cognia-bot status #0A1B2C3D", { kind: "status", taskRef: "0a1b2c3d" }],
  ["@cognia-bot status yesterday", { kind: "usage", reason: "bad_task_ref" }],
  ["@cognia-bot merge it", { kind: "usage", reason: "reserved_verb", verb: "merge" }],
  ["@cognia-bot ask\n@cognia-bot help", { kind: "usage", reason: "multiple_commands" }],
  ["@cognia-bot review", { kind: "usage", reason: "review_on_issue" }],
])("answers %j with a control reply", async (body, reply) => {
  const { f, consider } = setup()
  expect(await consider(event(body))).toBe("replied")
  expect(f.mocks.enqueue).toHaveBeenCalledTimes(1)
  expect(f.mocks.enqueue.mock.calls[0][1]).toMatchObject({
    triggerId: "reply",
    eventId: expect.stringMatching(/^gh-cmd-reply:4242:issue_comment:11:/),
    payload: { schemaVersion: 1, reply, target: { threadNumber: 7, sourceId: "11" } },
    resource: { id: "acme/widgets#7:issue_comment:11" },
  })
})

it("queues review only on pull requests, reading the thread kind a poll does not carry", async () => {
  const { f, consider } = setup()
  const candidate: Candidate = {
    action: "upsert",
    ingress: "poll",
    repository: { id: "4242", fullName: REPOSITORY },
    raw: {
      sourceKind: "issue_comment",
      id: 30,
      body: "@cognia-bot review security",
      createdAt: new Date(NOW - 1000).toISOString(),
      revision: new Date(NOW - 1000).toISOString(),
      user: AUTHOR,
      threadNumber: 8,
    },
  }
  expect(await consider(candidate)).toBe("queued")
  expect(f.mocks.enqueue.mock.calls[0][1]).toMatchObject({
    payload: { verb: "review", request: "security", threadKind: "pull_request", ingress: "poll" },
  })
})

it("supersedes an earlier version on edit, and withdraws work on deletion or a removed mention", async () => {
  const { f, consider } = setup()
  await consider(event("@cognia-bot ask first"))
  const edited = new Date(NOW - 30_000).toISOString()
  await consider(
    event("@cognia-bot ask second", "issue_comment.edited", {
      comment: issueComment(11, "@cognia-bot ask second", { updated_at: edited }),
    })
  )
  expect(f.deliveries.map((row) => row.status)).toEqual(["pending", "dismissed"])
  // An edit that drops the mention withdraws the command.
  await consider(
    event("never mind", "issue_comment.edited", {
      comment: issueComment(11, "never mind", { updated_at: new Date(NOW - 20_000).toISOString() }),
    })
  )
  expect(f.deliveries.every((row) => row.status === "dismissed" || row.triggerId === "reply")).toBe(
    true
  )
  // Tracking comments of withdrawn work are told (automatic mode).
  expect(
    f.mocks.enqueue.mock.calls.some(([, input]) => input.type === "github-command.tracking")
  ).toBe(true)
  await consider(
    event("@cognia-bot ask third", "issue_comment.created", {
      comment: issueComment(14, "@cognia-bot ask third"),
    })
  )
  expect(
    await consider(
      event("", "issue_comment.deleted", { comment: issueComment(14, "@cognia-bot ask third") })
    )
  ).toBe("cancelled")
})

it("refuses an edit made by someone other than the author", async () => {
  const { f, consider } = setup()
  await consider(event("@cognia-bot ask first"))
  expect(
    await consider(
      event("@cognia-bot ask something else", "issue_comment.edited", {
        sender: { id: 77, login: "maintainer" },
        comment: issueComment(11, "@cognia-bot ask something else", {
          updated_at: new Date(NOW).toISOString(),
        }),
      })
    )
  ).toBe("cancelled")
  expect(
    f.deliveries.filter((row) => row.triggerId === "execute").map((row) => row.status)
  ).toEqual(["dismissed"])
})

it("cancels the thread's latest or named task immediately and reports it", async () => {
  const { f, consider } = setup()
  await consider(
    event("@cognia-bot ask one", "issue_comment.created", {
      comment: issueComment(21, "@cognia-bot ask one"),
    })
  )
  await consider(
    event("@cognia-bot ask two", "issue_comment.created", {
      comment: issueComment(22, "@cognia-bot ask two"),
    })
  )
  expect(
    await consider(
      event("@cognia-bot cancel", "issue_comment.created", {
        comment: issueComment(23, "@cognia-bot cancel"),
      })
    )
  ).toBe("cancelled")
  const executes = f.deliveries.filter((row) => row.triggerId === "execute")
  expect(executes.map((row) => [row.resource?.id, row.status])).toEqual([
    ["acme/widgets#7:issue_comment:22", "dismissed"],
    ["acme/widgets#7:issue_comment:21", "pending"],
  ])
  const reply = f.mocks.enqueue.mock.calls.find(
    ([, input]) => input.type === "github-command.reply"
  )!
  expect((reply[1].payload as { reply: { taskRefs: string[] } }).reply.taskRefs).toHaveLength(1)
  expect(
    await consider(
      event("@cognia-bot cancel ffffffff", "issue_comment.created", {
        comment: issueComment(24, "@cognia-bot cancel ffffffff"),
      })
    )
  ).toBe("cancelled")
  expect(executes[1].status).toBe("pending")
})

it("reads every command event shape and drops other repositories", () => {
  expect(event("x")?.raw).toMatchObject({ sourceKind: "issue_comment", threadKind: "issue" })
  expect(
    candidateFromEvent(
      {
        type: "pull_request_review_comment.created",
        payload: {
          repository,
          sender: AUTHOR,
          pull_request: { number: 8 },
          comment: { ...issueComment(12, "x"), path: "a.ts", line: 3 },
        },
      },
      { repository: REPOSITORY }
    )?.raw
  ).toMatchObject({
    sourceKind: "review_comment",
    threadNumber: 8,
    review: { path: "a.ts", line: 3 },
  })
  expect(
    candidateFromEvent(
      {
        type: "pull_request_review.submitted",
        payload: {
          repository,
          sender: AUTHOR,
          pull_request: { number: 8 },
          review: { id: 13, body: "x", submitted_at: "t", user: AUTHOR, state: "COMMENTED" },
        },
      },
      { repository: REPOSITORY }
    )?.raw
  ).toMatchObject({ sourceKind: "review", id: 13 })
  expect(event("x", "issue_comment.deleted")?.action).toBe("delete")
  expect(
    candidateFromEvent(
      webhook("issue_comment.created", "x", { repository: { id: 1, full_name: "other/repo" } }),
      { repository: REPOSITORY }
    )
  ).toBeUndefined()
  expect(
    candidateFromEvent(
      { type: "issues.opened", payload: { repository } },
      { repository: REPOSITORY }
    )
  ).toBeUndefined()
})
