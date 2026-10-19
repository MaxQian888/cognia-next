import type { InstallerFailure } from "./client"
import {
  PLAN_STAGES,
  applyStageEvent,
  failRunningStage,
  failureCopy,
  initialProgress,
  nextStepFor,
  orderedOffers,
} from "./flow"

const bytes = (n: number) => `${n}B`

describe("stage progress", () => {
  it("lists the stages each plan runs", () => {
    expect(PLAN_STAGES.fresh).toEqual(["fetch", "upload", "stage", "service", "pair"])
    expect(PLAN_STAGES.re_pair).toEqual(["pair"])
    expect(PLAN_STAGES.uninstall).toEqual(["service"])
    expect(initialProgress("re_pair")).toEqual([{ stage: "pair", status: "pending" }])
  })

  it("moves a stage from pending to running to done or failed", () => {
    let progress = initialProgress("fresh")
    progress = applyStageEvent(progress, { stage: "fetch", outcome: null })
    expect(progress[0].status).toBe("running")
    progress = applyStageEvent(progress, { stage: "fetch", outcome: "ok" })
    progress = applyStageEvent(progress, { stage: "upload", outcome: null })
    progress = applyStageEvent(progress, { stage: "upload", outcome: "unknown" })
    expect(progress.map((entry) => entry.status)).toEqual([
      "done",
      "failed",
      "pending",
      "pending",
      "pending",
    ])
    // A stage the plan does not show (the inspection's probe) changes nothing.
    expect(applyStageEvent(progress, { stage: "probe", outcome: "ok" })).toEqual(progress)
  })

  it("fails the running stage when a failure arrives without its event", () => {
    const progress = applyStageEvent(initialProgress("uninstall"), {
      stage: "service",
      outcome: null,
    })
    expect(failRunningStage(progress)).toEqual([{ stage: "service", status: "failed" }])
  })
})

describe("nextStepFor", () => {
  it("never retries an unknown outcome in place", () => {
    expect(nextStepFor({ kind: "unknown", stage: "upload", message: "dropped" })).toBe("reinspect")
    expect(nextStepFor({ kind: "stale_inspection" })).toBe("reinspect")
  })

  it("retries only what did not reach the machine", () => {
    expect(nextStepFor({ kind: "fault", stage: "stage", message: "x" })).toBe("retry")
    expect(nextStepFor({ kind: "timeout", stage: "service" })).toBe("retry")
    expect(nextStepFor({ kind: "connect", message: "auth" })).toBe("reconnect")
    expect(
      nextStepFor({
        kind: "release",
        cause: "no_release",
        message: "x",
      })
    ).toBe("none")
    expect(
      nextStepFor({
        kind: "unsupported",
        reason: { cause: "windows" },
        message: "x",
      })
    ).toBe("none")
  })
})

describe("failureCopy", () => {
  it("names each unsupported cause with its values", () => {
    const glibc: InstallerFailure = {
      kind: "unsupported",
      reason: { cause: "glibc_too_old", found: "2.31", baseline: "2.35" },
      message: "glibc 2.31 is older",
    }
    expect(failureCopy(glibc, bytes)).toEqual({
      key: "unsupported.glibcTooOld",
      values: { found: "2.31", baseline: "2.35" },
      stage: null,
      detail: "glibc 2.31 is older",
    })
    expect(
      failureCopy(
        { kind: "unsupported", reason: { cause: "arch", name: "riscv64" }, message: "" },
        bytes
      ).values
    ).toEqual({ name: "riscv64" })
    expect(
      failureCopy(
        { kind: "unsupported", reason: { cause: "no_service_manager" }, message: "" },
        bytes
      ).key
    ).toBe("unsupported.noServiceManager")
  })

  it("keeps the stage and the English detail apart from the headline", () => {
    expect(failureCopy({ kind: "unknown", stage: "upload", message: "dropped" }, bytes)).toEqual({
      key: "unknown",
      values: {},
      stage: "upload",
      detail: "dropped",
    })
    expect(failureCopy({ kind: "not_enough_space", free: 10, needed: 20 }, bytes).values).toEqual({
      free: "10B",
      needed: "20B",
    })
    expect(
      failureCopy({ kind: "release", cause: "digest_mismatch", message: "x" }, bytes)
    ).toMatchObject({ key: "release.digestMismatch", stage: "fetch" })
    expect(
      failureCopy(
        {
          kind: "host_key_changed",
          change: {
            host: "box",
            port: 22,
            knownFingerprint: null,
            presentedFingerprint: "SHA256:new",
          },
        },
        bytes
      ).values
    ).toEqual({ known: "", presented: "SHA256:new" })
  })
})

describe("orderedOffers", () => {
  it("lists what was offered in a fixed order", () => {
    expect(orderedOffers(["uninstall", "re_pair", "repair"])).toEqual([
      "repair",
      "re_pair",
      "uninstall",
    ])
    expect(orderedOffers(["fresh"])).toEqual(["fresh"])
  })
})
