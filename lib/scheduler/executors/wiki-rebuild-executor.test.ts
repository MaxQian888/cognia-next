/**
 * @jest-environment node
 */

const mockRunWikiRebuild = jest.fn()
const mockIsTauri = jest.fn()

jest.mock("@/lib/wiki/rebuild-runner", () => {
  class HostFilesystemError extends Error {
    constructor() {
      super("HostFilesystem")
      this.name = "HostFilesystemError"
    }
  }
  class NoApiKeyError extends Error {
    constructor() {
      super("NoApiKey")
      this.name = "NoApiKeyError"
    }
  }
  return {
    runWikiRebuild: (...args: unknown[]) => mockRunWikiRebuild(...args),
    HostFilesystemError,
    WebModeError: HostFilesystemError,
    NoApiKeyError,
  }
})

// The executor's host gate reads `detectPlatform()`; "tauri" and "headless"
// both satisfy the `host-filesystem` requirement, "web" does not.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => (mockIsTauri() ? "tauri" : "web"),
  isTauri: () => mockIsTauri(),
}))

import { executeWikiRebuildTask } from "./wiki-rebuild-executor"
import { HostFilesystemError, NoApiKeyError } from "@/lib/wiki/rebuild-runner"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

function makeTask(payload: Record<string, unknown> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Wiki rebuild (nightly)",
    type: "wiki-rebuild",
    status: "active",
    payload,
    schedule: { kind: "interval", everyMs: 86_400_000 },
    config: { maxRetries: 0, timeout: 600_000 },
    createdAt: 0,
    updatedAt: 0,
  } as unknown as ScheduledTask
}

function makeExecution(): TaskExecution {
  return {
    id: "exec-1",
    taskId: "task-1",
    taskName: "Wiki rebuild (nightly)",
    taskType: "wiki-rebuild",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(0),
    logs: [],
  } as TaskExecution
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri.mockReturnValue(true)
})

describe("executeWikiRebuildTask", () => {
  it("returns success with rebuild counts on a normal run", async () => {
    mockRunWikiRebuild.mockResolvedValue({
      added: 4,
      changed: 2,
      removed: 1,
      unchanged: 50,
      errors: [],
      durationMs: 1234,
    })
    const r = await executeWikiRebuildTask(
      makeTask(),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(r.output).toEqual({
      added: 4,
      changed: 2,
      removed: 1,
      unchanged: 50,
      errors: 0,
      durationMs: 1234,
    })
    expect(mockRunWikiRebuild).toHaveBeenCalledWith({ force: false, rootDir: undefined })
  })

  it("passes force=true through to runWikiRebuild", async () => {
    mockRunWikiRebuild.mockResolvedValue({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
      errors: [],
      durationMs: 1,
    })
    await executeWikiRebuildTask(
      makeTask({ force: true }),
      makeExecution(),
      new AbortController().signal
    )
    expect(mockRunWikiRebuild).toHaveBeenCalledWith({ force: true, rootDir: undefined })
  })

  it("forwards a trimmed payload.rootDir to the runner", async () => {
    await executeWikiRebuildTask(
      makeTask({ rootDir: "  /srv/workspaces/notes  " }),
      makeExecution(),
      new AbortController().signal
    )
    expect(mockRunWikiRebuild).toHaveBeenCalledWith({
      force: false,
      rootDir: "/srv/workspaces/notes",
    })
  })

  it("returns a structured unsupported-on-host result on a host without a filesystem", async () => {
    mockIsTauri.mockReturnValue(false)
    const r = await executeWikiRebuildTask(
      makeTask(),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/host filesystem/i)
    expect(r.terminalReason).toBe("unsupported-on-host")
    expect(mockRunWikiRebuild).not.toHaveBeenCalled()
  })

  it("maps HostFilesystemError to a friendly message", async () => {
    mockRunWikiRebuild.mockRejectedValue(new HostFilesystemError())
    const r = await executeWikiRebuildTask(
      makeTask(),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/filesystem access/i)
  })

  it("maps NoApiKeyError to a configuration hint", async () => {
    mockRunWikiRebuild.mockRejectedValue(new NoApiKeyError())
    const r = await executeWikiRebuildTask(
      makeTask(),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key/i)
  })

  it("surfaces unknown errors verbatim", async () => {
    mockRunWikiRebuild.mockRejectedValue(new Error("boom"))
    const r = await executeWikiRebuildTask(
      makeTask(),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
  })

  it("surfaces rebuild-result errors in the output count", async () => {
    mockRunWikiRebuild.mockResolvedValue({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 50,
      errors: [{ module: "a", message: "x" }],
      durationMs: 99,
    })
    const r = await executeWikiRebuildTask(
      makeTask(),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect((r.output as { errors: number }).errors).toBe(1)
  })
})
