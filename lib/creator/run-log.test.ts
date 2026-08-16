const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

import {
  CREATOR_RUN_ID_PREFIX,
  createCreatorRunLog,
  isCreatorRunId,
  readCreatorProgress,
  relativeToAuthoringRoot,
} from "./run-log"
import { __flushRunEvents, listRunEvents } from "@/lib/workflow/runtime/event-log"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { computePermissionDiff } from "./permission-diff"
import type { AuthoringRoot } from "@/types/creator"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRunEvents.clear()
  mockTrackEvent.mockClear()
})

const RUN_ID = `${CREATOR_RUN_ID_PREFIX}abc`

const root: AuthoringRoot = {
  path: "/work/authoring",
  label: "authoring",
  origin: "selected",
  grantedAt: 0,
}

describe("isCreatorRunId", () => {
  it("recognises a Creator run and rejects a plain workflow run", () => {
    expect(isCreatorRunId(RUN_ID)).toBe(true)
    expect(isCreatorRunId("run_abc")).toBe(false)
  })
})

describe("relativeToAuthoringRoot", () => {
  it("strips the root prefix", () => {
    expect(relativeToAuthoringRoot(root, "/work/authoring/src/index.ts")).toBe("src/index.ts")
  })

  it("returns '.' for the root itself", () => {
    expect(relativeToAuthoringRoot(root, "/work/authoring")).toBe(".")
  })

  // The log is meant to be attachable to a bug report, so an escaping path is
  // reported as escaping rather than printed in full.
  it("redacts a path outside the root instead of echoing it", () => {
    expect(relativeToAuthoringRoot(root, "/Users/me/.ssh/id_rsa")).toBe("<outside-root>")
  })

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(relativeToAuthoringRoot(root, "/work/authoring-other/x.ts")).toBe("<outside-root>")
  })
})

describe("createCreatorRunLog", () => {
  it("records the run start without the absolute root path", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.started({ artifactKind: "plugin", rootLabel: root.label })
    await __flushRunEvents()

    const events = await listRunEvents(RUN_ID)
    expect(events).toHaveLength(1)
    const payload = events[0].payload as Record<string, unknown>
    expect(payload.artifactKind).toBe("plugin")
    expect(payload.rootLabel).toBe("authoring")
    expect(JSON.stringify(payload)).not.toContain("/work/authoring")
  })

  it("records a written file as a root-relative path and a byte count only", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.fileWritten("src/index.ts", 42)
    await __flushRunEvents()

    const events = await listRunEvents(RUN_ID)
    const payload = events[0].payload as { output: { path: string; bytes: number } }
    expect(payload.output).toEqual({ path: "src/index.ts", bytes: 42 })
  })

  it("records the diff before the approval so both sides are auditable", async () => {
    const log = createCreatorRunLog(RUN_ID)
    const diff = computePermissionDiff({ current: [], proposed: ["fs.write"] })
    await log.permissionDiff(diff)
    await log.approvalGranted("permission-widening", diff.added)
    await __flushRunEvents()

    const events = await listRunEvents(RUN_ID)
    expect(events.map((event) => event.stepId)).toEqual([
      "approve-permissions:diff",
      "approval:permission-widening",
    ])
  })

  it("records only finding ids and severities from a verdict", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.reviewVerdict({
      approved: false,
      reviewerAuthority: "plan",
      findings: [{ id: "f1", severity: "blocker", summary: "leaks a secret path" }],
    })
    await __flushRunEvents()

    const events = await listRunEvents(RUN_ID)
    // The summary is free text the model wrote; it stays out of the durable log.
    expect(JSON.stringify(events[0].payload)).not.toContain("leaks a secret path")
    expect(JSON.stringify(events[0].payload)).toContain("blocker")
  })
})

describe("readCreatorProgress", () => {
  it("returns empty progress for a run with no events", async () => {
    await expect(readCreatorProgress(RUN_ID)).resolves.toEqual({
      completed: [],
      failed: [],
      approvals: [],
    })
  })

  it("rebuilds completed steps in canonical order regardless of emit order", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.stepCompleted("plan-scaffold")
    await log.stepCompleted("collect-requirements")
    await log.stepCompleted("survey-existing")
    await __flushRunEvents()

    const progress = await readCreatorProgress(RUN_ID)
    expect(progress.completed).toEqual(["collect-requirements", "survey-existing", "plan-scaffold"])
  })

  it("moves a step from completed to failed when it later fails", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.stepCompleted("verify")
    await log.stepFailed("verify", "typecheck failed")
    await __flushRunEvents()

    const progress = await readCreatorProgress(RUN_ID)
    expect(progress.completed).not.toContain("verify")
    expect(progress.failed).toEqual(["verify"])
  })

  it("recovers a step that failed and then succeeded on retry", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.stepFailed("verify", "typecheck failed")
    await log.stepCompleted("verify")
    await __flushRunEvents()

    const progress = await readCreatorProgress(RUN_ID)
    expect(progress.completed).toEqual(["verify"])
    expect(progress.failed).toEqual([])
  })

  it("reconstructs granted approvals", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.approvalGranted("permission-widening", ["fs.write"])
    await __flushRunEvents()

    expect((await readCreatorProgress(RUN_ID)).approvals).toEqual(["permission-widening"])
  })

  // Revocation has to survive a reload, or a user who withdrew an approval
  // would find it silently restored by the next page load.
  it("drops an approval that was later denied", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.approvalGranted("permission-widening", ["fs.write"])
    await log.approvalDenied("permission-widening")
    await __flushRunEvents()

    expect((await readCreatorProgress(RUN_ID)).approvals).toEqual([])
  })

  it("ignores step ids that are not Creator steps", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.fileWritten("src/a.ts", 1)
    await log.permissionDiff(computePermissionDiff({ current: [], proposed: [] }))
    await __flushRunEvents()

    expect((await readCreatorProgress(RUN_ID)).completed).toEqual([])
  })

  it("does not read another run's events", async () => {
    const mine = createCreatorRunLog(RUN_ID)
    const other = createCreatorRunLog(`${CREATOR_RUN_ID_PREFIX}other`)
    await mine.stepCompleted("collect-requirements")
    await other.stepCompleted("verify")
    await __flushRunEvents()

    expect((await readCreatorProgress(RUN_ID)).completed).toEqual(["collect-requirements"])
  })

  it("records a run failure against the run, not a step", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.failed("sandbox unavailable", "preview")
    await __flushRunEvents()

    const events = await listRunEvents(RUN_ID)
    expect(events[0].type).toBe("run_failed")
    expect((await readCreatorProgress(RUN_ID)).failed).toEqual([])
  })

  it("records completion", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.completed()
    await __flushRunEvents()

    expect((await listRunEvents(RUN_ID))[0].type).toBe("run_completed")
  })

  it("records a skipped step", async () => {
    const log = createCreatorRunLog(RUN_ID)
    await log.stepStarted("preview")
    await log.stepSkipped("preview", "no sandbox")
    await __flushRunEvents()

    const progress = await readCreatorProgress(RUN_ID)
    expect(progress.completed).toEqual([])
    expect(progress.failed).toEqual([])
  })
})
