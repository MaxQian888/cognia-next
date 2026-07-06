import {
  syncRadarCronToScheduler,
  resolveRadarCron,
  RADAR_REPORT_TASK_ID,
} from "./radar-cron-bridge"
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

describe("resolveRadarCron", () => {
  it("maps presets and validates custom", () => {
    expect(resolveRadarCron({ mode: "off" })).toBeNull()
    expect(resolveRadarCron({ mode: "daily" })).toBe("0 9 * * *")
    expect(resolveRadarCron({ mode: "weekly" })).toBe("0 9 * * 1")
    expect(resolveRadarCron({ mode: "custom", customCron: "0 8 * * *" })).toBe("0 8 * * *")
    mockValidate.mockReturnValue({ valid: false })
    expect(resolveRadarCron({ mode: "custom", customCron: "bad" })).toBeNull()
  })
})

describe("syncRadarCronToScheduler", () => {
  it("creates a daily task", async () => {
    db.getTask.mockResolvedValue(null)
    const r = await syncRadarCronToScheduler({ mode: "daily" })
    expect(r.action).toBe("created")
    expect(db.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: RADAR_REPORT_TASK_ID, type: "radar-report" })
    )
  })

  it("deletes on off when a row exists", async () => {
    db.getTask.mockResolvedValue({ id: RADAR_REPORT_TASK_ID } as never)
    expect((await syncRadarCronToScheduler({ mode: "off" })).action).toBe("deleted")
  })

  it("reports an invalid custom cron", async () => {
    db.getTask.mockResolvedValue(null)
    mockValidate.mockReturnValue({ valid: false })
    const r = await syncRadarCronToScheduler({ mode: "custom", customCron: "nope" })
    expect(r.action).toBe("invalid")
  })

  it("skips when off and no row", async () => {
    db.getTask.mockResolvedValue(null)
    expect((await syncRadarCronToScheduler(undefined)).action).toBe("skipped")
  })
})
