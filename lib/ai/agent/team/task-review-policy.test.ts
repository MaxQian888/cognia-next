import {
  DEFAULT_TASK_REVIEW_MAX_REVISIONS,
  isTaskReviewEnabled,
  resolveMaxRevisions,
  reviewNodeId,
} from "./task-review-policy"
import type { AgentTeamConfig } from "@/types/agent/agent-team"

const config = (taskReview?: AgentTeamConfig["taskReview"]): AgentTeamConfig =>
  ({ taskReview }) as AgentTeamConfig

describe("isTaskReviewEnabled", () => {
  it("is off by default so an unconfigured team is unchanged", () => {
    expect(isTaskReviewEnabled(undefined)).toBe(false)
    expect(isTaskReviewEnabled(config())).toBe(false)
    expect(isTaskReviewEnabled(config({}))).toBe(false)
  })

  it("is on only when explicitly enabled", () => {
    expect(isTaskReviewEnabled(config({ enabled: true }))).toBe(true)
    expect(isTaskReviewEnabled(config({ enabled: false }))).toBe(false)
  })
})

describe("resolveMaxRevisions", () => {
  it("defaults to two worker revision attempts", () => {
    expect(resolveMaxRevisions(config({ enabled: true }))).toBe(DEFAULT_TASK_REVIEW_MAX_REVISIONS)
    expect(DEFAULT_TASK_REVIEW_MAX_REVISIONS).toBe(2)
  })

  it("honours an explicit budget", () => {
    expect(resolveMaxRevisions(config({ enabled: true, maxRevisions: 4 }))).toBe(4)
  })

  it("allows zero — review once, never revise", () => {
    expect(resolveMaxRevisions(config({ enabled: true, maxRevisions: 0 }))).toBe(0)
  })

  it("clamps nonsense rather than looping backwards", () => {
    expect(resolveMaxRevisions(config({ enabled: true, maxRevisions: -3 }))).toBe(0)
    expect(resolveMaxRevisions(config({ enabled: true, maxRevisions: 2.7 }))).toBe(2)
    expect(resolveMaxRevisions(config({ enabled: true, maxRevisions: NaN }))).toBe(
      DEFAULT_TASK_REVIEW_MAX_REVISIONS
    )
  })
})

describe("reviewNodeId", () => {
  it("namespaces the review node off its task id", () => {
    expect(reviewNodeId("t1")).toBe("review:t1")
  })

  it("cannot collide with the dispatch node it guards", () => {
    expect(reviewNodeId("t1")).not.toBe("t1")
  })
})
