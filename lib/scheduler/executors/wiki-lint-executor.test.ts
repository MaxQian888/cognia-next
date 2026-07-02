import { executeWikiLintTask } from "./wiki-lint-executor"
import { runWikiLint } from "@/lib/wiki/lint/lint-runner"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

jest.mock("@/lib/wiki/lint/lint-runner", () => ({ runWikiLint: jest.fn() }))
jest.mock("@/lib/logging", () => ({
  loggers: { scheduler: { info: jest.fn(), error: jest.fn() } },
}))

const mockRun = runWikiLint as jest.Mock

const task = { id: "t1" } as ScheduledTask
const execution = { id: "e1" } as TaskExecution
const signal = new AbortController().signal

beforeEach(() => jest.clearAllMocks())

describe("executeWikiLintTask", () => {
  it("returns finding counts on success", async () => {
    mockRun.mockResolvedValue({
      scope: "cognia-self",
      lastRunAt: 0,
      articleCount: 5,
      brokenLinks: [{ slug: "a", title: "a", deadLinks: ["x"] }],
      orphans: [{ slug: "b", title: "b" }],
    })
    const r = await executeWikiLintTask(task, execution, signal)
    expect(r.success).toBe(true)
    expect(r.output).toEqual({ articleCount: 5, brokenLinks: 1, orphans: 1 })
  })

  it("surfaces failures as an error", async () => {
    mockRun.mockRejectedValue(new Error("boom"))
    const r = await executeWikiLintTask(task, execution, signal)
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
  })
})
