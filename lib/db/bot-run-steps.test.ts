/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  beginBotRunStep,
  botRunStepId,
  clearBotRunSteps,
  completeBotRunStep,
  failBotRunStep,
  getBotRunStep,
  listBotRunSteps,
} from "./bot-run-steps"
import { __resetDbForTesting, getDb } from "./schema"

const NOW = 1_700_000_000_000

describe("botRunStepId", () => {
  it("keys on the run and the step name", () => {
    expect(botRunStepId("run_1", "fetch")).toBe("run_1::fetch")
    expect(botRunStepId("run_1", "fetch")).not.toBe(botRunStepId("run_2", "fetch"))
  })
})

describe("bot run steps", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botRunSteps.clear()
  }, 15_000)

  it("claims a fresh step as attempt one", async () => {
    expect(await beginBotRunStep("run_1", "fetch", NOW)).toEqual({ memoized: false, attempt: 1 })
  })

  it("hands back the stored output on a re-entry", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", { issues: 3 }, NOW + 1)

    expect(await beginBotRunStep("run_1", "fetch", NOW + 2)).toEqual({
      memoized: true,
      value: { issues: 3 },
    })
  })

  it("stores an output verbatim, including strings a redactor would rewrite", async () => {
    // This is the whole reason checkpoints are not run-journal events.
    const secretish = "https://api.github.com/repos/acme/web/pulls/42"
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", { url: secretish }, NOW + 1)

    const replay = await beginBotRunStep("run_1", "fetch", NOW + 2)
    expect(replay).toEqual({ memoized: true, value: { url: secretish } })
  })

  it("memoizes an explicitly undefined output as completed", async () => {
    await beginBotRunStep("run_1", "noop", NOW)
    await completeBotRunStep("run_1", "noop", undefined, NOW + 1)

    // A step that legitimately returned nothing must still count as done, or
    // it reruns on every resume.
    expect(await beginBotRunStep("run_1", "noop", NOW + 2)).toEqual({
      memoized: true,
      value: undefined,
    })
  })

  it("re-enters a failed step and counts the attempt", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await failBotRunStep("run_1", "fetch", "upstream 500", NOW + 1)

    // Only a completed step carries an output worth trusting, and the point of
    // a retry is to try the failing work again.
    expect(await beginBotRunStep("run_1", "fetch", NOW + 2)).toEqual({
      memoized: false,
      attempt: 2,
    })
  })

  it("keeps the failure row, so a retry is not mistaken for a first attempt", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await failBotRunStep("run_1", "fetch", "boom", NOW + 1)

    const row = await getBotRunStep("run_1", "fetch")
    expect(row?.status).toBe("failed")
    expect(row?.error).toBe("boom")
    expect(row?.startedAt).toBe(NOW)
  })

  it("keeps the first output when a completion is written twice", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", "first", NOW + 1)
    await completeBotRunStep("run_1", "fetch", "second", NOW + 2)

    expect(await getBotRunStep("run_1", "fetch")).toMatchObject({ output: "first" })
  })

  it("refuses to demote a completed step to failed", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", "done", NOW + 1)
    await failBotRunStep("run_1", "fetch", "late error", NOW + 2)

    // A late failure from an abandoned attempt must not erase a result the
    // handler already carried on from.
    expect(await getBotRunStep("run_1", "fetch")).toMatchObject({
      status: "completed",
      output: "done",
    })
  })

  it("keeps two runs' steps apart", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", "a", NOW)
    await beginBotRunStep("run_2", "fetch", NOW)

    expect(await beginBotRunStep("run_2", "fetch", NOW)).toEqual({ memoized: false, attempt: 2 })
    expect(await getBotRunStep("run_1", "fetch")).toMatchObject({ output: "a" })
  })

  it("lists a run's steps in the order they were reached", async () => {
    await beginBotRunStep("run_1", "first", NOW)
    await beginBotRunStep("run_1", "second", NOW + 5)

    expect((await listBotRunSteps("run_1")).map((s) => s.name)).toEqual(["first", "second"])
  })

  it("clears a run's checkpoints when a retry mints a fresh attempt", async () => {
    await beginBotRunStep("run_1", "a", NOW)
    await beginBotRunStep("run_1", "b", NOW)
    await beginBotRunStep("run_2", "a", NOW)

    expect(await clearBotRunSteps("run_1")).toBe(2)
    expect(await listBotRunSteps("run_1")).toEqual([])
    expect(await listBotRunSteps("run_2")).toHaveLength(1)
  })
})
