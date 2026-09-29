/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const engine = {
  start: jest.fn(),
  cancel: jest.fn(async () => undefined),
  recheck: jest.fn(async () => undefined),
}
jest.mock("@/lib/ai/media/video-jobs/host", () => ({ getVideoJobEngine: () => engine }))
jest.mock("@/lib/ai/media/video-jobs/renderer-host", () => ({
  ensureRendererVideoJobHost: jest.fn(),
}))

let videoUrl: { status: string; url?: string } = { status: "idle" }
jest.mock("@/hooks/chat/use-video-job-url", () => ({ useVideoJobUrl: () => videoUrl }))
jest.mock("@/hooks/fleet/use-now-ticker", () => ({ useNowTicker: () => 65_000 }))
jest.mock("@/components/chat/renderers/video-block", () => ({
  VideoBlock: ({ src }: { src: string }) => <video data-testid="video-block" src={src} />,
}))

const postVideoJobCard = jest.fn(async () => undefined)
jest.mock("@/lib/chat/video-job-card", () => ({
  postVideoJobCard: (...args: unknown[]) => postVideoJobCard(...(args as [])),
}))

let liveRow: MediaGenerationJobRow | undefined | null = null
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveRow }))

import { VideoJobCard, VideoJobView } from "./video-job-view"

function job(overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id: "vjob_1",
    kind: "video",
    sessionId: "s1",
    origin: { surface: "slash", sessionId: "s1" },
    request: { prompt: "A paper boat on a rainy street" },
    provider: { providerId: "doubao", modelId: "seedance-1-5-pro-251215", credentialAffinity: "a" },
    operation: {},
    status: "generating",
    pollCount: 0,
    nextPollAt: 0,
    deadlineAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  videoUrl = { status: "idle" }
  liveRow = null
})

describe("VideoJobView", () => {
  it("renders nothing while the row loads and says so when the job is gone", () => {
    const { container, rerender } = render(<VideoJobView jobId="vjob_1" />)
    expect(container).toBeEmptyDOMElement()
    liveRow = undefined
    rerender(<VideoJobView jobId="vjob_2" />)
    expect(screen.getByText("missingJob")).toBeInTheDocument()
  })

  it("renders the live row", () => {
    liveRow = job()
    render(<VideoJobView jobId="vjob_1" />)
    expect(screen.getByTestId("video-job-card")).toHaveAttribute("data-status", "generating")
  })
})

describe("VideoJobCard while generating", () => {
  it("shows the prompt, elapsed time and a real cancel for a provider that has one", async () => {
    render(<VideoJobCard jobId="vjob_1" row={job()} />)
    expect(screen.getByText("status.generating")).toBeInTheDocument()
    expect(screen.getByText("A paper boat on a rainy street")).toBeInTheDocument()
    expect(screen.getByText(/elapsed:\{"elapsed":"1:05"\}/)).toBeInTheDocument()
    expect(screen.queryByText(/stopWaitingHint/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    await waitFor(() => expect(engine.cancel).toHaveBeenCalledWith("vjob_1"))
  })

  it("offers only 'stop waiting', with the billing warning, where the provider cannot cancel", () => {
    render(
      <VideoJobCard
        jobId="vjob_1"
        row={job({ provider: { providerId: "google", modelId: "veo", credentialAffinity: "a" } })}
      />
    )
    expect(screen.getByRole("button", { name: "stopWaiting" })).toBeInTheDocument()
    expect(screen.getByText(/stopWaitingHint/)).toBeInTheDocument()
  })

  it("mentions a failed check that is being retried, and hides cancel while downloading", () => {
    render(
      <VideoJobCard jobId="vjob_1" row={job({ status: "downloading", lastPollError: "503" })} />
    )
    expect(screen.getByText(/lastPollError/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "cancel" })).not.toBeInTheDocument()
  })

  it("notes an image-to-video job", () => {
    render(
      <VideoJobCard
        jobId="vjob_1"
        row={job({
          request: { prompt: "x", startFrame: { kind: "session-asset", assetId: "f" } },
        })}
      />
    )
    expect(screen.getByText("startFrame")).toBeInTheDocument()
  })
})

describe("VideoJobCard when settled", () => {
  const result = {
    content: { kind: "session-asset" as const, sessionId: "s1", assetId: "video-vjob_1" },
    mediaType: "video/mp4",
    byteSize: 10,
  }

  it("plays the stored video", () => {
    videoUrl = { status: "ready", url: "blob:v" }
    render(<VideoJobCard jobId="vjob_1" row={job({ status: "succeeded", result })} />)
    expect(screen.getByTestId("video-block")).toHaveAttribute("src", "blob:v")
    expect(screen.queryByRole("button", { name: /tryAgain/ })).not.toBeInTheDocument()
  })

  it("says when the stored video is gone", () => {
    videoUrl = { status: "missing" }
    render(<VideoJobCard jobId="vjob_1" row={job({ status: "succeeded", result })} />)
    expect(screen.getByText("missingVideo")).toBeInTheDocument()
  })

  it("explains a failure by its code and offers a new try, not a recheck", () => {
    render(
      <VideoJobCard
        jobId="vjob_1"
        row={job({
          status: "failed",
          error: {
            code: "generation_failed",
            message: "flagged by moderation",
            recheckable: false,
          },
        })}
      />
    )
    expect(screen.getByRole("alert")).toHaveTextContent("errors.generationFailed")
    expect(screen.getByText("flagged by moderation")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /checkAgain/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /tryAgain/ })).toBeInTheDocument()
  })

  it("checks a timed-out job again", async () => {
    render(
      <VideoJobCard
        jobId="vjob_1"
        row={job({
          status: "timed_out",
          error: { code: "timed_out", message: "Did not finish in 30 minutes.", recheckable: true },
        })}
      />
    )
    expect(screen.getByText("status.timedOut")).toBeInTheDocument()
    expect(screen.queryByText("Did not finish in 30 minutes.")).not.toBeInTheDocument()
    // The localized line says it; the engine's English sentence is not repeated.
    expect(screen.getByRole("alert")).toHaveTextContent("errors.timedOut")
    fireEvent.click(screen.getByRole("button", { name: /checkAgain/ }))
    await waitFor(() => expect(engine.recheck).toHaveBeenCalledWith("vjob_1"))
  })

  it("starts a repeat and posts its card into the conversation", async () => {
    engine.start.mockResolvedValue({ ok: true, job: { id: "vjob_2" } })
    render(
      <VideoJobCard jobId="vjob_1" row={job({ status: "cancelled", remoteCancelled: true })} />
    )
    expect(screen.getByText("cancelledRemote")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /tryAgain/ }))
    })
    expect(engine.start).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "A paper boat on a rainy street",
        origin: { surface: "slash", sessionId: "s1" },
      })
    )
    expect(postVideoJobCard).toHaveBeenCalledWith("s1", "vjob_2")
  })

  it("reports a repeat the engine refused", async () => {
    engine.start.mockResolvedValue({
      ok: false,
      error: { code: "no_provider", message: "none configured", recheckable: false },
    })
    render(<VideoJobCard jobId="vjob_1" row={job({ status: "cancelled" })} />)
    expect(screen.getByText("cancelledLocal")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /tryAgain/ }))
    })
    expect(screen.getByText(/retryFailed/)).toHaveTextContent("errors.noProvider")
    expect(postVideoJobCard).not.toHaveBeenCalled()
  })
})
