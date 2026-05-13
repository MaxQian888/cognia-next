import { ghEventToInbound, shouldBridgeToInbox } from "./inbox-bridge"
import type { NormalizedGhEvent } from "@/lib/github/types"

const baseEvent = (overrides: Partial<NormalizedGhEvent> = {}): NormalizedGhEvent => ({
  deliveryId: "del-1",
  kind: "pull_request.opened",
  repoFullName: "octocat/hello",
  rawEvent: "pull_request",
  rawAction: "opened",
  senderLogin: "alice",
  seenAt: 1_700_000_000_000,
  source: "webhook",
  ...overrides,
})

describe("shouldBridgeToInbox", () => {
  it("bridges human-relevant kinds", () => {
    expect(shouldBridgeToInbox("pull_request.opened")).toBe(true)
    expect(shouldBridgeToInbox("pull_request.review_requested")).toBe(true)
    expect(shouldBridgeToInbox("issues.assigned")).toBe(true)
    expect(shouldBridgeToInbox("issue_comment.created")).toBe(true)
  })

  it("skips automation-only kinds", () => {
    expect(shouldBridgeToInbox("check_run.completed")).toBe(false)
    expect(shouldBridgeToInbox("release.published")).toBe(false)
    expect(shouldBridgeToInbox("pull_request.synchronize")).toBe(false)
    expect(shouldBridgeToInbox("issues.labeled")).toBe(false)
  })
})

describe("ghEventToInbound", () => {
  it("returns null for kinds we don't bridge", () => {
    expect(
      ghEventToInbound(baseEvent({ kind: "check_run.completed", checkRun: { name: "lint" } }))
    ).toBeNull()
  })

  it("maps pull_request.opened into a thread-scoped InboundEvent", () => {
    const result = ghEventToInbound(
      baseEvent({
        kind: "pull_request.opened",
        pr: { repo: "octocat/hello", prNumber: 42, authorLogin: "alice" },
      })
    )
    expect(result).not.toBeNull()
    expect(result!.platform).toBe("github")
    expect(result!.adapterId).toBe("github-delivery")
    expect(result!.messageId).toBe("del-1")
    expect(result!.channel.kind).toBe("thread")
    expect(result!.channel.id).toBe("octocat/hello#pr-42")
    expect(result!.plainText).toMatch(/opened PR #42/)
    expect(result!.segments[0]).toEqual({ type: "text", text: result!.plainText })
  })

  it("maps issues.assigned to a per-issue thread", () => {
    const result = ghEventToInbound(
      baseEvent({
        kind: "issues.assigned",
        issue: { repo: "octocat/hello", issueNumber: 5, authorLogin: "bob" },
      })
    )
    expect(result?.channel.id).toBe("octocat/hello#issue-5")
    expect(result?.plainText).toMatch(/assigned issue #5/)
  })

  it("falls back to 'anonymous' when senderLogin is missing", () => {
    const result = ghEventToInbound(
      baseEvent({
        kind: "issue_comment.created",
        senderLogin: undefined,
        issue: { repo: "octocat/hello", issueNumber: 1 },
      })
    )
    expect(result?.sender.remoteUserId).toBe("anonymous")
    expect(result?.plainText).toMatch(/^someone commented/)
  })

  it("preserves the original event under `raw`", () => {
    const event = baseEvent({
      kind: "pull_request.opened",
      pr: { repo: "octocat/hello", prNumber: 1 },
    })
    const result = ghEventToInbound(event)
    expect(result?.raw).toBe(event)
    expect(result?.channelData).toEqual({ kind: "pull_request.opened", ref: undefined })
  })
})
