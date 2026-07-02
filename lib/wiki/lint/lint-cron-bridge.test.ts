import { syncWikiLintCronToScheduler, WIKI_LINT_TASK_ID } from "./lint-cron-bridge"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { validateCronExpression } from "@/lib/scheduler/cron-parser"

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: {
    getTask: jest.fn(),
    createTask: jest.fn(),
    updateTask: jest.fn(),
    deleteTask: jest.fn(),
  },
}))
jest.mock("@/lib/scheduler/cron-parser", () => ({ validateCronExpression: jest.fn() }))

const db = schedulerDb as jest.Mocked<typeof schedulerDb>
const mockValidate = validateCronExpression as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockValidate.mockReturnValue({ valid: true })
})

describe("syncWikiLintCronToScheduler", () => {
  it("creates a task for a daily schedule", async () => {
    db.getTask.mockResolvedValue(null)
    const r = await syncWikiLintCronToScheduler({ mode: "daily" })
    expect(r.action).toBe("created")
    expect(db.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: WIKI_LINT_TASK_ID, type: "wiki-lint" })
    )
  })

  it("updates an existing task", async () => {
    db.getTask.mockResolvedValue({ id: WIKI_LINT_TASK_ID } as never)
    const r = await syncWikiLintCronToScheduler({ mode: "weekly" })
    expect(r.action).toBe("updated")
    expect(db.updateTask).toHaveBeenCalled()
  })

  it("deletes the row when mode is off", async () => {
    db.getTask.mockResolvedValue({ id: WIKI_LINT_TASK_ID } as never)
    const r = await syncWikiLintCronToScheduler({ mode: "off" })
    expect(r.action).toBe("deleted")
    expect(db.deleteTask).toHaveBeenCalledWith(WIKI_LINT_TASK_ID)
  })

  it("skips when off and no row exists", async () => {
    db.getTask.mockResolvedValue(null)
    expect((await syncWikiLintCronToScheduler(undefined)).action).toBe("skipped")
  })

  it("reports an invalid custom cron", async () => {
    db.getTask.mockResolvedValue(null)
    mockValidate.mockReturnValue({ valid: false })
    const r = await syncWikiLintCronToScheduler({ mode: "custom", customCron: "nope" })
    expect(r.action).toBe("invalid")
    expect(r.invalidExpression).toBe("nope")
  })

  it("creates a task for a valid custom cron", async () => {
    db.getTask.mockResolvedValue(null)
    const r = await syncWikiLintCronToScheduler({ mode: "custom", customCron: "0 4 * * *" })
    expect(r.action).toBe("created")
  })
})
