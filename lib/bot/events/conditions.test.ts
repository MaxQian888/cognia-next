import { botConditionMismatch } from "./conditions"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

const event = (payload: unknown = {}, extra = {}) => ({ payload, ...extra }) as BotEventEnvelopeV1

describe("structured Bot trigger conditions", () => {
  it("keeps existing triggers compatible", () => {
    expect(botConditionMismatch(undefined, event(null))).toBeUndefined()
    expect(botConditionMismatch({}, event([]))).toBeUndefined()
  })
  it("requires the configured repository and fails closed on missing data", () => {
    const conditions = { repositoryConfigKey: "repository", repositories: ["owner/repo"] }
    expect(
      botConditionMismatch(conditions, event({ repository: { full_name: "other/repo" } }))
    ).toBe("repository")
    expect(
      botConditionMismatch(conditions, event({}, { resource: { scope: "owner/repo" } }), {
        repository: "owner/repo",
      })
    ).toBeUndefined()
    expect(botConditionMismatch({ repositoryConfigKey: "repository" }, event({}))).toBe(
      "repository"
    )
  })
  it("matches branch, labels, actor and draft together", () => {
    const payload = {
      pull_request: { base: { ref: "main" }, labels: [{ name: "ready" }, "safe"], draft: false },
      sender: { login: "maintainer" },
    }
    const conditions = {
      branches: ["main"],
      labels: ["ready", "safe"],
      actors: ["maintainer"],
      draft: false,
    }
    expect(botConditionMismatch(conditions, event(payload))).toBeUndefined()
    expect(botConditionMismatch({ ...conditions, branches: ["dev"] }, event(payload))).toBe(
      "branch"
    )
    expect(botConditionMismatch({ labels: ["missing"] }, event(payload))).toBe("labels")
    expect(botConditionMismatch({ actors: ["other"] }, event(payload))).toBe("actor")
    expect(botConditionMismatch({ draft: true }, event(payload))).toBe("draft")
  })
  it("normalizes issue labels, CI conclusions and fallback actor fields", () => {
    expect(
      botConditionMismatch(
        { conclusions: ["failure"], branches: ["dev"] },
        event({ workflow_run: { conclusion: "failure", head_branch: "dev" } })
      )
    ).toBeUndefined()
    expect(
      botConditionMismatch(
        { conclusions: ["failure"] },
        event({ check_run: { conclusion: "success" } })
      )
    ).toBe("conclusion")
    expect(
      botConditionMismatch(
        { labels: ["triage"], actors: ["ada"], branches: ["main"] },
        event({ issue: { labels: ["triage", {}] }, ref: "main" }, { actor: { id: "ada" } })
      )
    ).toBeUndefined()
    expect(botConditionMismatch({ labels: ["triage"] }, event({ issue: { labels: null } }))).toBe(
      "labels"
    )
  })
})
