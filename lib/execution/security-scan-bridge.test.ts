/** @jest-environment jsdom */
import { getExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  securityScanExecutionRunId,
  securityScanRunStatus,
  syncSecurityScanExecutionRun,
  type SecurityScanRunRecord,
} from "./security-scan-bridge"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SOURCE = "scan-1"
const RUN_ID = securityScanExecutionRunId(SOURCE)

function record(overrides: Partial<SecurityScanRunRecord> = {}): SecurityScanRunRecord {
  return {
    runId: SOURCE,
    target: "https://example.com",
    startedAt: 1_000,
    status: "running",
    findingsCount: 0,
    ...overrides,
  }
}

const eventTypes = async () => (await listExecutionRunEvents(RUN_ID)).map((event) => event.type)

describe("securityScanRunStatus", () => {
  it("maps a clean finish to completed", () => {
    expect(securityScanRunStatus(record({ status: "done" }))).toBe("completed")
  })

  it("maps an unreadable report to failed even though the scan said done", () => {
    // The mapping the whole kind exists for: Strix can exit 0 having written
    // an artifact nobody could parse, and a green row for that would report a
    // scan that may have found criticals as a success.
    expect(securityScanRunStatus(record({ status: "done", reportUnreadable: true }))).toBe("failed")
  })

  it("maps an error to failed and a cancellation to cancelled", () => {
    expect(securityScanRunStatus(record({ status: "error" }))).toBe("failed")
    expect(securityScanRunStatus(record({ status: "cancelled" }))).toBe("cancelled")
  })
})

describe("syncSecurityScanExecutionRun", () => {
  it("projects a running scan under its own kind, titled by target", () => {
    return (async () => {
      await syncSecurityScanExecutionRun(record())
      expect(await getExecutionRun(RUN_ID)).toMatchObject({
        kind: "security-scan",
        sourceId: SOURCE,
        title: "https://example.com",
        status: "running",
      })
      expect(await eventTypes()).toEqual(["run.started"])
    })()
  })

  it("is idempotent across the repeated onRun calls a scan emits", async () => {
    await syncSecurityScanExecutionRun(record())
    await syncSecurityScanExecutionRun(record())
    await syncSecurityScanExecutionRun(record())
    expect(await eventTypes()).toEqual(["run.started"])
  })

  it("settles a clean scan as completed with a count and no findings", async () => {
    await syncSecurityScanExecutionRun(record())
    await syncSecurityScanExecutionRun(record({ status: "done", endedAt: 2_000, findingsCount: 3 }))
    expect(await getExecutionRun(RUN_ID)).toMatchObject({ status: "completed" })
    const events = await listExecutionRunEvents(RUN_ID)
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"])
    expect(events[1].payload.summary).toBe("Scan finished with 3 finding(s)")
  })

  it("settles an unreadable scan as failed and says it is inconclusive", async () => {
    await syncSecurityScanExecutionRun(record())
    await syncSecurityScanExecutionRun(
      record({ status: "done", endedAt: 2_000, reportUnreadable: true })
    )
    expect(await getExecutionRun(RUN_ID)).toMatchObject({ status: "failed" })
    const events = await listExecutionRunEvents(RUN_ID)
    expect(events[1].type).toBe("run.failed")
    expect(events[1].payload.summary).toMatch(/inconclusive/)
  })

  it("does not re-settle a run that already settled", async () => {
    await syncSecurityScanExecutionRun(record())
    await syncSecurityScanExecutionRun(record({ status: "done", endedAt: 2_000 }))
    await syncSecurityScanExecutionRun(record({ status: "done", endedAt: 2_000 }))
    expect(await eventTypes()).toEqual(["run.started", "run.completed"])
  })

  it("projects a scan that settled before it was ever seen running", async () => {
    // `onRun` can be missed entirely if the panel mounts late; the terminal
    // record alone must still produce a complete run.
    await syncSecurityScanExecutionRun(record({ status: "error", endedAt: 2_000 }))
    expect(await getExecutionRun(RUN_ID)).toMatchObject({ status: "failed" })
    expect(await eventTypes()).toEqual(["run.started", "run.failed"])
  })

  it("keeps finding detail out of the journal entirely", async () => {
    // The journal is projected onto IM cards and remote surfaces; a working
    // exploit against a named host must never travel there.
    await syncSecurityScanExecutionRun(record())
    await syncSecurityScanExecutionRun(record({ status: "done", endedAt: 2_000, findingsCount: 2 }))
    const serialized = JSON.stringify(await listExecutionRunEvents(RUN_ID))
    expect(serialized).not.toMatch(/poc|exploit|curl/i)
  })

  it("records a cancelled scan as cancelled, not failed", async () => {
    await syncSecurityScanExecutionRun(record())
    await syncSecurityScanExecutionRun(record({ status: "cancelled", endedAt: 2_000 }))
    expect(await getExecutionRun(RUN_ID)).toMatchObject({ status: "cancelled" })
    expect(await eventTypes()).toEqual(["run.started", "run.cancelled"])
  })
})
