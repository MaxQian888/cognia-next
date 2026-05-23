import {
  computePollingDeliveryId,
  normalizePollingDiff,
  normalizeWebhook,
  type WebhookEnvelope,
} from "./event-normalizer"

const REPO = { full_name: "octocat/hello-world" }
const SENDER = { login: "ghbot" }

const env = (event: string, action: string, extra: Record<string, unknown>): WebhookEnvelope => ({
  event,
  deliveryId: `del-${event}-${action}-${Math.random().toString(36).slice(2, 8)}`,
  payload: { action, repository: REPO, sender: SENDER, ...extra },
  receivedAt: 1_700_000_000_000,
})

describe("normalizeWebhook", () => {
  it("maps pull_request.opened with PR fields", () => {
    const result = normalizeWebhook(
      env("pull_request", "opened", {
        pull_request: {
          number: 42,
          user: { login: "alice" },
          head: { sha: "abc123", ref: "feat/x" },
          base: { ref: "main" },
        },
      })
    )
    expect(result?.kind).toBe("pull_request.opened")
    expect(result?.pr).toMatchObject({
      repo: "octocat/hello-world",
      prNumber: 42,
      headSha: "abc123",
      baseRef: "main",
      authorLogin: "alice",
    })
    expect(result?.ref).toBe("abc123")
    expect(result?.source).toBe("webhook")
  })

  it("maps pull_request.synchronize", () => {
    const result = normalizeWebhook(
      env("pull_request", "synchronize", { pull_request: { number: 1, head: { ref: "feat/x" } } })
    )
    expect(result?.kind).toBe("pull_request.synchronize")
    expect(result?.ref).toBe("feat/x")
  })

  it("maps pull_request.closed and review_requested", () => {
    expect(
      normalizeWebhook(env("pull_request", "closed", { pull_request: { number: 7 } }))?.kind
    ).toBe("pull_request.closed")
    expect(
      normalizeWebhook(env("pull_request", "review_requested", { pull_request: { number: 7 } }))
        ?.kind
    ).toBe("pull_request.review_requested")
  })

  it("maps issues.opened, closed, assigned, labeled with author", () => {
    const result = normalizeWebhook(
      env("issues", "opened", { issue: { number: 5, user: { login: "bob" } } })
    )
    expect(result?.kind).toBe("issues.opened")
    expect(result?.issue).toMatchObject({
      repo: "octocat/hello-world",
      issueNumber: 5,
      authorLogin: "bob",
    })
    expect(normalizeWebhook(env("issues", "closed", { issue: { number: 5 } }))?.kind).toBe(
      "issues.closed"
    )
    expect(normalizeWebhook(env("issues", "assigned", { issue: { number: 5 } }))?.kind).toBe(
      "issues.assigned"
    )
    expect(normalizeWebhook(env("issues", "labeled", { issue: { number: 5 } }))?.kind).toBe(
      "issues.labeled"
    )
  })

  it("maps issue_comment.created", () => {
    const result = normalizeWebhook(env("issue_comment", "created", { issue: { number: 1 } }))
    expect(result?.kind).toBe("issue_comment.created")
  })

  it("maps check_run.completed with conclusion", () => {
    const result = normalizeWebhook(
      env("check_run", "completed", {
        check_run: { name: "lint", conclusion: "failure" },
      })
    )
    expect(result?.kind).toBe("check_run.completed")
    expect(result?.checkRun).toEqual({ name: "lint", conclusion: "failure" })
  })

  it("maps release.published with tag set as ref", () => {
    const result = normalizeWebhook(
      env("release", "published", {
        release: { tag_name: "v1.2.0", name: "Cool release", draft: false },
      })
    )
    expect(result?.kind).toBe("release.published")
    expect(result?.release).toEqual({ tag: "v1.2.0", name: "Cool release", draft: false })
    expect(result?.ref).toBe("v1.2.0")
  })

  it("returns null for unsupported event/action combos", () => {
    expect(normalizeWebhook(env("ping", "", {}))).toBeNull()
    expect(normalizeWebhook(env("pull_request", "edited", {}))).toBeNull()
  })

  it("returns null when repository is missing", () => {
    const result = normalizeWebhook({
      event: "pull_request",
      deliveryId: "x",
      payload: { action: "opened" },
    })
    expect(result).toBeNull()
  })

  it("uses Date.now() when receivedAt is omitted", () => {
    const before = Date.now()
    const result = normalizeWebhook({
      event: "issues",
      deliveryId: "x",
      payload: { action: "opened", repository: REPO, issue: { number: 1 } },
    })
    expect(result!.seenAt).toBeGreaterThanOrEqual(before)
  })

  it("falls back to payload.ref when no PR/release is present", () => {
    const result = normalizeWebhook({
      event: "issues",
      deliveryId: "x",
      payload: {
        action: "opened",
        repository: REPO,
        issue: { number: 1 },
        ref: "refs/heads/main",
      },
    })
    expect(result?.ref).toBe("refs/heads/main")
  })
})

describe("computePollingDeliveryId", () => {
  it("is deterministic for the same inputs", () => {
    const a = computePollingDeliveryId("issues.opened", "o/r", 5)
    const b = computePollingDeliveryId("issues.opened", "o/r", 5)
    expect(a).toBe(b)
  })

  it("differs across kind, repo, or id", () => {
    const a = computePollingDeliveryId("issues.opened", "o/r", 5)
    expect(a).not.toBe(computePollingDeliveryId("issues.closed", "o/r", 5))
    expect(a).not.toBe(computePollingDeliveryId("issues.opened", "o/q", 5))
    expect(a).not.toBe(computePollingDeliveryId("issues.opened", "o/r", 6))
  })
})

describe("normalizePollingDiff", () => {
  it("normalizes a PR diff entry", () => {
    const result = normalizePollingDiff({
      kind: "pull_request.opened",
      repoFullName: "octocat/hello-world",
      primaryId: 42,
      pr: { prNumber: 42, headSha: "deadbeef", baseRef: "main", authorLogin: "alice" },
      seenAt: 1_700_000_000_000,
    })
    expect(result.source).toBe("polling")
    expect(result.deliveryId).toBe(
      computePollingDeliveryId("pull_request.opened", "octocat/hello-world", 42)
    )
    expect(result.pr).toMatchObject({ prNumber: 42, headSha: "deadbeef" })
    expect(result.ref).toBe("deadbeef")
  })

  it("normalizes an Issue diff entry", () => {
    const result = normalizePollingDiff({
      kind: "issues.opened",
      repoFullName: "octocat/hello-world",
      primaryId: 7,
      issue: { issueNumber: 7, authorLogin: "bob" },
    })
    expect(result.issue).toEqual({
      repo: "octocat/hello-world",
      issueNumber: 7,
      authorLogin: "bob",
    })
    expect(result.rawAction).toBe("opened")
  })

  it("normalizes a Release diff entry with tag in ref", () => {
    const result = normalizePollingDiff({
      kind: "release.published",
      repoFullName: "octocat/hello-world",
      primaryId: "v2.0.0",
      release: { tag: "v2.0.0", draft: false },
    })
    expect(result.ref).toBe("v2.0.0")
  })

  it("uses Date.now() when seenAt is omitted", () => {
    const before = Date.now()
    const result = normalizePollingDiff({
      kind: "issues.opened",
      repoFullName: "o/r",
      primaryId: 1,
      issue: { issueNumber: 1 },
    })
    expect(result.seenAt).toBeGreaterThanOrEqual(before)
  })
})
