const mockGet = jest.fn(async (_id: string): Promise<unknown> => ({ id: "i1" }))
const mockAppend = jest.fn(async (input: unknown) => input)
jest.mock("@/lib/db/issues", () => ({ getIssue: (id: string) => mockGet(id) }))
jest.mock("@/lib/db/issue-events", () => ({ appendIssueEvent: (i: unknown) => mockAppend(i) }))

import { recordWorkSettled, recordWorkStarted } from "./work-item-link"

beforeEach(() => {
  mockGet.mockClear()
  mockAppend.mockClear()
  mockGet.mockResolvedValue({ id: "i1" })
})

describe("work item link", () => {
  it("writes a started entry with a source-shaped actor when none is given", async () => {
    expect(await recordWorkStarted({ issueId: "i1", submissionId: "s1", source: "chat" })).toBe(
      true
    )
    expect(mockAppend).toHaveBeenCalledWith({
      issueId: "i1",
      payload: {
        kind: "work_started",
        submissionId: "s1",
        source: "chat",
        by: { kind: "agent", id: "work:chat", label: "chat" },
      },
    })
  })

  it("writes the outcome on settle", async () => {
    await recordWorkSettled({
      issueId: "i1",
      submissionId: "s1",
      source: "plan",
      outcome: "failed",
    })
    expect(mockAppend).toHaveBeenCalledWith({
      issueId: "i1",
      payload: { kind: "work_settled", submissionId: "s1", source: "plan", to: "failed" },
    })
  })

  it("is a no-op for an issue that no longer exists", async () => {
    mockGet.mockResolvedValueOnce(undefined)
    expect(await recordWorkStarted({ issueId: "gone", submissionId: "s", source: "chat" })).toBe(
      false
    )
    expect(mockAppend).not.toHaveBeenCalled()
  })
})
