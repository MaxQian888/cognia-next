import {
  EMPTY_AGENT_TEAM_DRAFT,
  EMPTY_GOAL_DRAFT,
  EMPTY_PLAN_DRAFT,
  payloadToAgentTeamDraft,
  payloadToGoalDraft,
  payloadToPlanDraft,
  agentTeamDraftToPayload,
  goalDraftToPayload,
  planDraftToPayload,
  isStructuredEditableTaskType,
  DraftValidationError,
} from "./types"

describe("agent-team converters", () => {
  it("round-trips a payload", () => {
    const draft = payloadToAgentTeamDraft({ teamId: "t1", ultracode: true })
    expect(draft).toEqual({ teamId: "t1", ultracode: true })
    expect(agentTeamDraftToPayload(draft)).toEqual({ teamId: "t1", ultracode: true })
  })

  it("drops ultracode=false from the payload", () => {
    expect(agentTeamDraftToPayload({ teamId: "t1", ultracode: false })).toEqual({ teamId: "t1" })
  })

  it("defaults on a non-object payload", () => {
    expect(payloadToAgentTeamDraft(null)).toEqual(EMPTY_AGENT_TEAM_DRAFT)
    expect(payloadToAgentTeamDraft([1, 2])).toEqual(EMPTY_AGENT_TEAM_DRAFT)
  })

  it("throws when teamId is missing", () => {
    expect(() => agentTeamDraftToPayload({ teamId: "  ", ultracode: false })).toThrow(
      DraftValidationError
    )
  })
})

describe("goal converters", () => {
  it("maps config minutes to ms and back", () => {
    const draft = payloadToGoalDraft({
      objective: "do x",
      characterId: "c1",
      config: { maxTurns: 5, maxTokens: 1000, timeoutMs: 120_000 },
    })
    expect(draft).toMatchObject({
      objective: "do x",
      characterId: "c1",
      maxTurns: 5,
      maxTokens: 1000,
      timeoutMinutes: 2,
    })
    const payload = goalDraftToPayload(draft)
    expect(payload).toMatchObject({
      objective: "do x",
      characterId: "c1",
      config: { maxTurns: 5, maxTokens: 1000, timeoutMs: 120_000 },
    })
  })

  it("omits an empty config", () => {
    expect(goalDraftToPayload({ objective: "x" })).toEqual({ objective: "x" })
  })

  it("throws when objective is missing", () => {
    expect(() => goalDraftToPayload({ objective: "" })).toThrow(DraftValidationError)
  })

  it("defaults on a non-object payload", () => {
    expect(payloadToGoalDraft(undefined)).toEqual(EMPTY_GOAL_DRAFT)
  })
})

describe("plan converters", () => {
  it("round-trips a payload", () => {
    const draft = payloadToPlanDraft({ planId: "p1", replanOnFailure: true })
    expect(draft).toEqual({ planId: "p1", replanOnFailure: true })
    expect(planDraftToPayload(draft)).toEqual({ planId: "p1", replanOnFailure: true })
  })

  it("drops replanOnFailure=false", () => {
    expect(planDraftToPayload({ planId: "p1", replanOnFailure: false })).toEqual({ planId: "p1" })
  })

  it("throws when planId is missing", () => {
    expect(() => planDraftToPayload({ planId: "", replanOnFailure: false })).toThrow(
      DraftValidationError
    )
  })

  it("defaults on a non-object payload", () => {
    expect(payloadToPlanDraft("nope")).toEqual(EMPTY_PLAN_DRAFT)
  })
})

describe("isStructuredEditableTaskType", () => {
  it("includes the new multi-agent types", () => {
    expect(isStructuredEditableTaskType("agent-team")).toBe(true)
    expect(isStructuredEditableTaskType("goal")).toBe(true)
    expect(isStructuredEditableTaskType("plan")).toBe(true)
  })

  it("excludes non-structured types", () => {
    expect(isStructuredEditableTaskType("backup")).toBe(false)
    expect(isStructuredEditableTaskType("workflow")).toBe(false)
  })
})
