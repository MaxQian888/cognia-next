/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/chat/video-generation/video-job-view", () => ({
  VIDEO_JOB_ERROR_KEYS: { no_provider: "errors.noProvider", generation_failed: "errors.gen" },
  videoJobErrorDetail: (error: { code: string; message?: string }) =>
    error.code === "generation_failed" ? (error.message ?? null) : null,
  VideoJobView: ({ jobId }: { jobId: string }) => <div data-testid="video-job-view">{jobId}</div>,
}))

import { VideoGenerateCard } from "./video-generate-card"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-video_generate",
    toolCallId: "c1",
    state: "output-available",
    input: {},
    output,
  } as unknown as ToolUIPart
}

describe("VideoGenerateCard", () => {
  it("renders the started job's live card", () => {
    render(<VideoGenerateCard part={part({ ok: true, jobId: "vjob_1", status: "generating" })} />)
    expect(screen.getByTestId("video-job-view")).toHaveTextContent("vjob_1")
  })

  it("explains a refused start by its code", () => {
    render(
      <VideoGenerateCard
        part={part({ ok: false, code: "no_provider", error: "No provider configured." })}
      />
    )
    expect(screen.getByRole("alert")).toHaveTextContent("errors.noProvider")
    expect(screen.queryByText("No provider configured.")).not.toBeInTheDocument()
  })

  it("keeps the provider's own detail under its code", () => {
    render(
      <VideoGenerateCard part={part({ ok: false, code: "generation_failed", error: "flagged" })} />
    )
    expect(screen.getByRole("alert")).toHaveTextContent("errors.gen")
    expect(screen.getByText("flagged")).toBeInTheDocument()
  })

  it("falls back to a generic line for a tool-level refusal", () => {
    render(<VideoGenerateCard part={part({ ok: false, code: "no_image", error: "No image." })} />)
    expect(screen.getByRole("alert")).toHaveTextContent("notStarted")
    expect(screen.getByText("No image.")).toBeInTheDocument()
  })

  it("renders nothing before the result arrives, so the generic tool block shows", () => {
    const { container } = render(<VideoGenerateCard part={part(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
