import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting } from "@/lib/goal/runtime"

const schedulerMock = {
  createTask: jest.fn().mockResolvedValue({ id: "task_1" }),
  pauseTask: jest.fn().mockResolvedValue(true),
  resumeTask: jest.fn().mockResolvedValue(true),
  deleteTask: jest.fn().mockResolvedValue(true),
}
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

import { __resetLoopRuntimeForTesting, getLoopRuntime } from "@/lib/loop/runtime"
import { LoopSettingsTab } from "./settings-tab"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetLoopRuntimeForTesting()
  __resetGoalRuntimeForTesting()
})

describe("LoopSettingsTab", () => {
  it("saves an edited iteration cap through the runtime", async () => {
    const loop = await getLoopRuntime().createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "self_paced",
    })
    render(<LoopSettingsTab loop={loop} />)
    expect(screen.getByTestId("loop-config-save")).toBeDisabled()
    fireEvent.change(screen.getByTestId("loop-config-max-iterations"), { target: { value: "7" } })
    expect(screen.getByTestId("loop-config-save")).toBeEnabled()
    fireEvent.click(screen.getByTestId("loop-config-save"))
    await waitFor(async () => {
      const updated = await getLoopRuntime().getOpenLoopForSession("ses_a")
      expect(updated?.config.maxIterations).toBe(7)
    })
  })

  it("shows delay-bound fields only for self-paced loops", async () => {
    const sp = await getLoopRuntime().createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "self_paced",
    })
    const { unmount } = render(<LoopSettingsTab loop={sp} />)
    expect(screen.getByTestId("loop-config-min-delay")).toBeInTheDocument()
    expect(screen.getByTestId("loop-config-max-delay")).toBeInTheDocument()
    unmount()
    const iv = await getLoopRuntime().createLoop({
      sessionId: "ses_b",
      rawPrompt: "x",
      mode: "interval",
      intervalMs: 60_000,
    })
    render(<LoopSettingsTab loop={iv} />)
    expect(screen.queryByTestId("loop-config-min-delay")).toBeNull()
  })

  it("disables every field for terminal loops", async () => {
    const loop = await getLoopRuntime().createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "self_paced",
    })
    const stopped = (await getLoopRuntime().stopLoop(loop.id))!
    render(<LoopSettingsTab loop={stopped} />)
    expect(screen.getByTestId("loop-config-max-iterations")).toBeDisabled()
    expect(screen.getByTestId("loop-config-save")).toBeDisabled()
  })

  it("resets the draft when bound to a different loop", async () => {
    const a = await getLoopRuntime().createLoop({
      sessionId: "ses_a",
      rawPrompt: "a",
      mode: "self_paced",
      config: { maxIterations: 11 },
    })
    const b = await getLoopRuntime().createLoop({
      sessionId: "ses_b",
      rawPrompt: "b",
      mode: "self_paced",
      config: { maxIterations: 22 },
    })
    const { rerender } = render(<LoopSettingsTab loop={a} />)
    expect(screen.getByTestId("loop-config-max-iterations")).toHaveValue(11)
    rerender(<LoopSettingsTab loop={b} />)
    expect(screen.getByTestId("loop-config-max-iterations")).toHaveValue(22)
  })
})
