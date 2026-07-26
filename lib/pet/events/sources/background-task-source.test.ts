import {
  createBackgroundTaskSource,
  wireBackgroundTaskSource,
  type BackgroundTaskLifecycleEvent,
} from "./background-task-source"
import {
  __clearRendererBackgroundRunsForTesting,
  startRendererBackgroundRun,
} from "@/lib/background-tasks/renderer-subagent-registry"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

describe("createBackgroundTaskSource", () => {
  it("aggregates concurrent tasks and settles only after the last task finishes", () => {
    let onLifecycle: (event: BackgroundTaskLifecycleEvent) => void = () => {
      throw new Error("Subscriber was not wired")
    }
    const dispose = jest.fn()
    const emit = jest.fn()
    const wire = createBackgroundTaskSource({
      getActive: () => [],
      subscribe: (listener) => {
        onLifecycle = listener
        return dispose
      },
    })

    const stop = wire(emit)
    onLifecycle({ type: "started", runId: "run-1", taskKind: "subagent" })
    onLifecycle({ type: "started", runId: "run-2", taskKind: "plugin-agent" })
    onLifecycle({ type: "settled", runId: "run-1", status: "done" })

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenLastCalledWith({
      source: "background-task",
      kind: "thinking",
      xp: 0,
      meta: { activeCount: 1, runId: "run-1", taskKind: "subagent" },
    })

    onLifecycle({ type: "settled", runId: "run-2", status: "done" })
    expect(emit).toHaveBeenLastCalledWith({
      source: "background-task",
      kind: "success",
      xp: 3,
      meta: { activeCount: 0, runId: "run-2", status: "done" },
    })

    stop()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("keeps a batch failed when any concurrent task fails", () => {
    let onLifecycle: (event: BackgroundTaskLifecycleEvent) => void = () => {}
    const emit = jest.fn()
    const wire = createBackgroundTaskSource({
      getActive: () => [],
      subscribe: (listener) => {
        onLifecycle = listener
        return () => {}
      },
    })

    wire(emit)
    onLifecycle({ type: "started", runId: "run-1", taskKind: "subagent" })
    onLifecycle({ type: "started", runId: "run-2", taskKind: "subagent" })
    onLifecycle({ type: "settled", runId: "run-1", status: "error" })
    onLifecycle({ type: "settled", runId: "run-2", status: "done" })

    expect(emit).toHaveBeenLastCalledWith({
      source: "background-task",
      kind: "error",
      xp: 0,
      meta: { activeCount: 0, runId: "run-2", status: "error" },
    })
  })

  it("surfaces background work already running at mount and ignores unknown settlements", () => {
    let onLifecycle: (event: BackgroundTaskLifecycleEvent) => void = () => {}
    const emit = jest.fn()
    const wire = createBackgroundTaskSource({
      getActive: () => [{ runId: "existing", taskKind: "team-delegation" }],
      subscribe: (listener) => {
        onLifecycle = listener
        return () => {}
      },
    })

    wire(emit)
    expect(emit).toHaveBeenCalledWith({
      source: "background-task",
      kind: "thinking",
      xp: 0,
      meta: { activeCount: 1, runId: "existing", taskKind: "team-delegation" },
    })

    onLifecycle({ type: "settled", runId: "unknown", status: "error" })
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it("uses the production lifecycle subscription without observing task content", async () => {
    __clearRendererBackgroundRunsForTesting()
    const emit = jest.fn()
    const stop = wireBackgroundTaskSource(emit)
    const result: PluginSubagentDispatchResult = {
      text: "private result",
      channel: "text",
      toolsAvailable: false,
      runId: "runtime-run",
    }

    startRendererBackgroundRun(
      "runtime-run",
      {
        kind: "subagent",
        subagentId: "worker",
        prompt: "private prompt",
        sessionId: "session",
        host: "renderer",
        startedAt: 1,
      },
      Promise.resolve(result)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(emit.mock.calls.map(([event]) => event.kind)).toEqual(["thinking", "success"])
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private")

    stop()
    __clearRendererBackgroundRunsForTesting()
  })
})
