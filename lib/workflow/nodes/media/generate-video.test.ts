/**
 * @jest-environment jsdom
 */
const openWorkflowBlob = jest.fn(async (_r: string): Promise<unknown> => ({
  bytes: new Uint8Array([9, 9]),
  mediaType: "image/png",
}))
jest.mock("@/lib/workflow/blobs/store", () => ({
  isWorkflowBlobRef: (v: unknown) => typeof v === "string" && v.startsWith("cognia-workflow-blob:"),
  openWorkflowBlob: (r: string) => openWorkflowBlob(r),
}))

import type { StartVideoJobInput, StartVideoJobResult } from "@/lib/ai/media/video-jobs/engine"
import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { getExecutor } from "../registry"
import {
  GENERATE_VIDEO_TIMEOUT_MS,
  __setGenerateVideoDepsForTesting,
  jobOfStep,
  type GenerateVideoNodeDeps,
} from "./generate-video"

const KIND = "action.media.generateVideo"

function row(overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id: "vjob_1",
    kind: "video",
    origin: { surface: "workflow", runId: "run1", stepId: "s1" },
    request: { prompt: "a boat" },
    provider: { providerId: "doubao", modelId: "seedance-1", credentialAffinity: "a" },
    operation: {},
    status: "succeeded",
    pollCount: 3,
    nextPollAt: 0,
    deadlineAt: 0,
    createdAt: 0,
    updatedAt: 0,
    result: {
      content: {
        kind: "file",
        relativePath: "generated-videos/vjob_1.mp4",
        path: "/data/generated-videos/vjob_1.mp4",
      },
      mediaType: "video/mp4",
      byteSize: 1234,
      durationSec: 5,
      width: 1280,
      height: 720,
    },
    ...overrides,
  }
}

let deps: {
  runsOnThisMachine: jest.Mock<boolean, []>
  start: jest.Mock<Promise<StartVideoJobResult>, [StartVideoJobInput]>
  wait: jest.Mock<Promise<MediaGenerationJobRow | undefined>, [string, AbortSignal?]>
  liveJobs: jest.Mock<Promise<MediaGenerationJobRow[]>, []>
  settings: jest.Mock
  configuredProviders: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  deps = {
    runsOnThisMachine: jest.fn(() => true),
    liveJobs: jest.fn(async () => []),
    start: jest.fn<Promise<StartVideoJobResult>, [StartVideoJobInput]>(async () => ({
      ok: true,
      job: row({ status: "generating" }),
    })),
    wait: jest.fn<Promise<MediaGenerationJobRow | undefined>, [string, AbortSignal?]>(async () =>
      row()
    ),
    settings: jest.fn(() => ({ agentTool: true, providerId: "doubao", durationSec: 10 })),
    configuredProviders: jest.fn(() => ["doubao", "google"]),
  }
  __setGenerateVideoDepsForTesting(deps as unknown as GenerateVideoNodeDeps)
})
afterAll(() => __setGenerateVideoDepsForTesting(null))

function run(
  params: Record<string, unknown>,
  signal?: AbortSignal,
  extra: Partial<StepExecutionContext> = {}
) {
  const executor = getExecutor(KIND as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: "run1",
    stepId: "s1",
    ...(signal ? { signal } : {}),
    ...extra,
  } as unknown as StepExecutionContext)
}

// Registration happens on import.
import "./generate-video"

describe("action.media.generateVideo", () => {
  it("registers as a non-retryable step that outlives the job deadline", () => {
    const executor = getExecutor(KIND as never, 1)!
    expect(executor.retryable).toBe(false)
    expect(executor.timeoutMs).toBe(GENERATE_VIDEO_TIMEOUT_MS)
    expect(GENERATE_VIDEO_TIMEOUT_MS).toBeGreaterThan(30 * 60_000)
  })

  it("starts a workflow job with the saved defaults and outputs the file", async () => {
    const result = await run({ prompt: "  a boat  " }, undefined, { projectId: "p1" })
    expect(deps.start).toHaveBeenCalledWith({
      prompt: "a boat",
      providerId: "doubao",
      params: { durationSec: 10 },
      origin: { surface: "workflow", runId: "run1", stepId: "s1" },
      projectId: "p1",
    })
    expect(deps.wait).toHaveBeenCalledWith("vjob_1", undefined)
    expect(result.output).toEqual({
      jobId: "vjob_1",
      outputPath: "/data/generated-videos/vjob_1.mp4",
      mediaType: "video/mp4",
      byteSize: 1234,
      durationSeconds: 5,
      width: 1280,
      height: 720,
      providerId: "doubao",
      modelId: "seedance-1",
      warnings: [],
    })
  })

  it("lets the node's own choices win and treats empty choices as unset", async () => {
    await run({
      prompt: "a boat",
      providerId: "google",
      model: "veo-3.1-generate-preview",
      durationSec: 8,
      aspectRatio: "9:16",
      resolution: "",
    })
    expect(deps.start.mock.calls[0]![0]).toMatchObject({
      providerId: "google",
      model: "veo-3.1-generate-preview",
      params: { durationSec: 8, aspectRatio: "9:16" },
    })
  })

  it("passes a start image from an earlier node as bytes", async () => {
    await run({ prompt: "a boat", blobRef: "cognia-workflow-blob:b1" })
    expect(openWorkflowBlob).toHaveBeenCalledWith("cognia-workflow-blob:b1")
    expect(deps.start.mock.calls[0]![0].startFrame).toEqual({
      kind: "bytes",
      data: new Uint8Array([9, 9]),
      mediaType: "image/png",
    })
  })

  it("refuses a missing prompt, a bad duration and a start 'image' that is not one", async () => {
    await expect(run({ prompt: " " })).rejects.toThrow("requires 'prompt'")
    await expect(run({ prompt: "a", durationSec: 2.5 })).rejects.toThrow("whole number")
    openWorkflowBlob.mockResolvedValueOnce({ bytes: new Uint8Array([1]), mediaType: "video/mp4" })
    await expect(run({ prompt: "a", blobRef: "cognia-workflow-blob:v" })).rejects.toThrow(
      "must be an image"
    )
    expect(deps.start).not.toHaveBeenCalled()
  })

  it("reports a refused start and a failed job by their codes, without retrying", async () => {
    deps.start.mockResolvedValueOnce({
      ok: false,
      error: { code: "no_provider", message: "none configured", recheckable: false },
    })
    await expect(run({ prompt: "a" })).rejects.toMatchObject({
      message: expect.stringContaining("no_provider: none configured"),
    })
    deps.wait.mockResolvedValueOnce(
      row({
        status: "failed",
        result: undefined,
        error: { code: "generation_failed", message: "moderated", recheckable: false },
      })
    )
    await expect(run({ prompt: "a" })).rejects.toThrow("generation_failed: moderated")
    deps.wait.mockResolvedValueOnce(row({ status: "timed_out", result: undefined }))
    await expect(run({ prompt: "a" })).rejects.toThrow("timed_out")
  })

  it("runs only in the desktop app with no remote host attached", async () => {
    deps.runsOnThisMachine.mockReturnValue(false)
    await expect(run({ prompt: "a" })).rejects.toThrow("only in the desktop app")
    expect(deps.start).not.toHaveBeenCalled()
  })

  it("picks up the job it started before an interruption instead of paying again", async () => {
    deps.liveJobs.mockResolvedValue([row({ id: "vjob_earlier", status: "generating" })])
    deps.wait.mockResolvedValue(row({ id: "vjob_earlier" }))
    const result = await run({ prompt: "a boat" })
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.wait).toHaveBeenCalledWith("vjob_earlier", undefined)
    expect(result.output).toMatchObject({ jobId: "vjob_earlier" })
  })

  it("keys the job to its loop iteration", async () => {
    const iteration = { loopId: "loop", iterationIndex: 2 }
    deps.liveJobs.mockResolvedValue([
      row({
        id: "vjob_other_iteration",
        origin: {
          surface: "workflow",
          runId: "run1",
          stepId: "s1",
          iteration: { loopId: "loop", iterationIndex: 1 },
        },
      }),
    ])
    await run({ prompt: "a" }, undefined, { iteration })
    expect(deps.start.mock.calls[0]![0].origin).toEqual({
      surface: "workflow",
      runId: "run1",
      stepId: "s1",
      iteration,
    })
  })

  it("says the job was cancelled with a cancelled run", async () => {
    const controller = new AbortController()
    deps.wait.mockImplementationOnce(async () => {
      controller.abort()
      return row({ status: "cancelled", result: undefined })
    })
    await expect(run({ prompt: "a" }, controller.signal)).rejects.toThrow("run was cancelled")
    expect(deps.start.mock.calls[0]![0].abortSignal).toBe(controller.signal)
  })
})

describe("jobOfStep", () => {
  const origin = { surface: "workflow", runId: "r", stepId: "s" } as const

  it("finds the newest job of the same run, step and iteration", () => {
    const rows = [
      row({ id: "old", origin, createdAt: 1 }),
      row({ id: "new", origin, createdAt: 2 }),
      row({ id: "other-step", origin: { ...origin, stepId: "t" }, createdAt: 3 }),
      row({ id: "other-run", origin: { ...origin, runId: "q" }, createdAt: 4 }),
      row({ id: "chat", origin: { surface: "slash", sessionId: "s" }, createdAt: 5 }),
      row({
        id: "looped",
        origin: { ...origin, iteration: { loopId: "l", iterationIndex: 0 } },
        createdAt: 6,
      }),
    ]
    expect(jobOfStep(rows, origin)?.id).toBe("new")
    expect(jobOfStep(rows, { ...origin, iteration: { loopId: "l", iterationIndex: 0 } })?.id).toBe(
      "looped"
    )
    expect(jobOfStep([], origin)).toBeUndefined()
  })
})
