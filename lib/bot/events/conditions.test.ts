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

  it("matches envelope-rooted paths against scalars and lists", () => {
    // Lark/Slack-shaped payloads: the type sits inside payload.event, the
    // sender kind on the envelope actor.
    const lark = event(
      { event: { type: "im.message.receive_v1", message: { chat_id: "c1" } } },
      { actor: { kind: "user", id: "u-1" } }
    )
    expect(
      botConditionMismatch(
        { match: { "payload.event.type": "im.message.receive_v1", "actor.kind": "user" } },
        lark
      )
    ).toBeUndefined()
    expect(
      botConditionMismatch({ match: { "payload.event.type": "im.message.recalled" } }, lark)
    ).toBe("match:payload.event.type")
    // Array membership.
    expect(botConditionMismatch({ match: { "actor.kind": ["bot", "user"] } }, lark)).toBeUndefined()
    expect(botConditionMismatch({ match: { "actor.kind": ["bot", "app"] } }, lark)).toBe(
      "match:actor.kind"
    )
  })

  it("matches PagerDuty-shaped incident payloads on envelope paths", () => {
    // The pagerduty plugin's normalizer projects `event.data` onto
    // `payload.incident`; a responder Bot can gate on urgency/service without
    // new condition code.
    const incident = event({
      incident: {
        id: "P1ABC",
        status: "triggered",
        urgency: "high",
        service: { id: "SVC1", summary: "checkout" },
      },
    })
    expect(
      botConditionMismatch(
        {
          match: {
            "payload.incident.urgency": "high",
            "payload.incident.service.id": "SVC1",
          },
        },
        incident
      )
    ).toBeUndefined()
    expect(botConditionMismatch({ match: { "payload.incident.urgency": ["low"] } }, incident)).toBe(
      "match:payload.incident.urgency"
    )
  })

  it("never matches a missing, null, or object-valued path", () => {
    const conditions = { match: { "payload.deep.value": 1 } }
    expect(botConditionMismatch(conditions, event({}))).toBe("match:payload.deep.value")
    expect(botConditionMismatch(conditions, event({ deep: { value: null } }))).toBe(
      "match:payload.deep.value"
    )
    expect(botConditionMismatch(conditions, event({ deep: { value: { x: 1 } } }))).toBe(
      "match:payload.deep.value"
    )
    // Prototype segments are misses, not reads.
    expect(botConditionMismatch({ match: { "__proto__.polluted": true } }, event({}))).toBe(
      "match:__proto__.polluted"
    )
  })

  it("compares numbers and booleans with strict equality", () => {
    const payload = { pr: { count: 3, merged: true } }
    expect(
      botConditionMismatch(
        { match: { "payload.pr.count": 3, "payload.pr.merged": true } },
        event(payload)
      )
    ).toBeUndefined()
    expect(botConditionMismatch({ match: { "payload.pr.count": "3" } }, event(payload))).toBe(
      "match:payload.pr.count"
    )
    expect(botConditionMismatch({ match: { "payload.pr.merged": false } }, event(payload))).toBe(
      "match:payload.pr.merged"
    )
  })

  it("composes with the structured conditions", () => {
    const payload = {
      pull_request: { base: { ref: "main" }, draft: false },
      repository: { full_name: "owner/repo" },
      action: "opened",
    }
    const conditions = {
      repositories: ["owner/repo"],
      branches: ["main"],
      match: { "payload.action": ["opened", "reopened"] },
    }
    expect(botConditionMismatch(conditions, event(payload))).toBeUndefined()
    expect(botConditionMismatch(conditions, event({ ...payload, action: "closed" }))).toBe(
      "match:payload.action"
    )
    expect(
      botConditionMismatch(conditions, event({ ...payload, repository: { full_name: "x/y" } }))
    ).toBe("repository")
  })
})
