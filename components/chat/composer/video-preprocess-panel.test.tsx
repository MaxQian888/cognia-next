import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { VideoPreprocessResult } from "@/lib/chat/attachments/video/preprocess"
import {
  DEFAULT_VIDEO_SETTINGS,
  type VideoPreprocessSettings,
} from "@/lib/chat/attachments/video/settings"
import type { StagedAttachmentState } from "./staged-attachment-store"
import { VideoPreprocessPanel } from "./video-preprocess-panel"

const image = (bytes = 2048) => ({
  mediaType: "image/jpeg",
  base64: "AAAA",
  bytes,
  width: 320,
  height: 180,
})

function result(over: Partial<VideoPreprocessResult> = {}): VideoPreprocessResult {
  const settings = over.settings ?? DEFAULT_VIDEO_SETTINGS
  return {
    engine: "browser",
    source: { kind: "video", mediaType: "video/mp4", durationSec: 30, width: 1920, height: 1080 },
    settings,
    sampled: {
      delivery: "storyboard",
      frames: [
        { timeSec: 1.5, reason: "start" },
        { timeSec: 15, reason: "uniform" },
      ],
      grid: { columns: 2, rows: 1 },
      images: [image(4096)],
      description: "desc",
      blocks: [],
      estimatedImageTokens: 1200,
    },
    native: null,
    nativeFailure: null,
    nativeTrimSupported: true,
    poster: image(),
    ...over,
  }
}

function ready(
  video: Partial<NonNullable<StagedAttachmentState["video"]>> = {}
): StagedAttachmentState {
  const r = video.result === undefined ? result() : video.result
  return {
    status: "ready",
    sizeBytes: 1024,
    video: { settings: r?.settings ?? DEFAULT_VIDEO_SETTINGS, result: r, ...video },
  }
}

const OPEN = { available: true } as const

function renderPanel(props: Partial<React.ComponentProps<typeof VideoPreprocessPanel>> = {}) {
  const onApply = jest.fn<void, [VideoPreprocessSettings]>()
  const view = render(
    <VideoPreprocessPanel
      filename="clip.mp4"
      state={ready()}
      routeVerdict={OPEN}
      onApply={onApply}
      {...props}
    />
  )
  return { ...view, onApply: (props.onApply as jest.Mock | undefined) ?? onApply }
}

const deliveryGroup = () => screen.getByRole("radiogroup", { name: "Send as" })
const radio = (group: HTMLElement, name: string) => within(group).getByRole("radio", { name })

describe("VideoPreprocessPanel — source and output", () => {
  it("summarises the source and the engine that opened it", () => {
    renderPanel()
    expect(screen.getByText("0:30.0 · 1920×1080 · Decoded in the app")).toBeInTheDocument()
  })

  it("counts a GIF's frames", () => {
    renderPanel({
      state: ready({
        result: result({
          engine: "gif",
          source: {
            kind: "gif",
            mediaType: "image/gif",
            durationSec: 2,
            width: 40,
            height: 30,
            frameCount: 6,
          },
        }),
      }),
    })
    expect(screen.getByText("0:02.0 · 6 frames · 40×30 · Decoded as a GIF")).toBeInTheDocument()
  })

  it("shows the storyboard the model receives with its cost", () => {
    renderPanel()
    const output = screen.getByRole("region", { name: "What the model receives" })
    expect(within(output).getByAltText("Storyboard of clip.mp4")).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,AAAA"
    )
    expect(within(output).getByText("~1200 image tokens · 4.0KB")).toBeInTheDocument()
  })

  it("lists separate frames with their timestamps", () => {
    const settings = { ...DEFAULT_VIDEO_SETTINGS, delivery: "frames" as const, frameCount: 2 }
    const base = result()
    renderPanel({
      state: ready({
        result: result({
          settings,
          sampled: {
            ...base.sampled,
            delivery: "frames",
            grid: undefined,
            images: [image(), image()],
          },
        }),
      }),
    })
    const frames = screen.getByTestId("video-frames")
    expect(within(frames).getByAltText("Frame at 0:01.5")).toBeInTheDocument()
    expect(within(frames).getByAltText("Frame at 0:15.0")).toBeInTheDocument()
    expect(screen.getByText("~1200 image tokens · 4.0KB")).toBeInTheDocument()
  })

  it("shows the poster and size for a prepared original video", () => {
    const settings = { ...DEFAULT_VIDEO_SETTINGS, delivery: "native" as const }
    renderPanel({
      state: ready({
        result: result({
          settings,
          native: { mediaType: "video/mp4", bytes: 3 * 1024 * 1024, description: "d", blocks: [] },
        }),
      }),
    })
    expect(screen.getByText("Original video · 3.0MB")).toBeInTheDocument()
    expect(
      screen.getByText("If the model that runs can't take video, the storyboard is sent instead.")
    ).toBeInTheDocument()
    expect(screen.queryByTestId("video-storyboard")).not.toBeInTheDocument()
    // Frame counts mean nothing for the original file.
    expect(screen.queryByRole("radiogroup", { name: "Pick frames" })).not.toBeInTheDocument()
  })

  it("explains a native failure and shows the storyboard that goes instead", () => {
    const settings = { ...DEFAULT_VIDEO_SETTINGS, delivery: "native" as const }
    renderPanel({
      state: ready({ result: result({ settings, native: null, nativeFailure: "too-large" }) }),
    })
    expect(screen.getByTestId("native-failure")).toHaveTextContent(
      "The file is over 10 MB. Pick a shorter range or send frames instead."
    )
    expect(screen.getByTestId("video-storyboard")).toBeInTheDocument()
  })

  it("says when scene sampling found no cuts, and not for a single frame", () => {
    const settings = { ...DEFAULT_VIDEO_SETTINGS, strategy: "scene" as const }
    const { rerender } = renderPanel({ state: ready({ result: result({ settings }) }) })
    const note = "No clear scene changes were found, so frames are evenly spaced."
    expect(screen.getByText(note)).toBeInTheDocument()

    const base = result()
    const single = result({
      settings: { ...settings, delivery: "frames", frameCount: 1 },
      sampled: { ...base.sampled, delivery: "frames", frames: [{ timeSec: 0, reason: "start" }] },
    })
    rerender(
      <VideoPreprocessPanel
        filename="clip.mp4"
        state={ready({ result: single })}
        routeVerdict={OPEN}
        onApply={jest.fn()}
      />
    )
    expect(screen.queryByText(note)).not.toBeInTheDocument()
  })

  it("notes when ffmpeg opened a file the webview could not", () => {
    renderPanel({
      state: ready({ result: result({ engine: "ffmpeg", browserFailure: "decode error" }) }),
    })
    expect(
      screen.getByText("The app couldn't decode this file, so ffmpeg opened it.")
    ).toBeInTheDocument()
  })
})

describe("VideoPreprocessPanel — delivery", () => {
  it("disables the original-video option with the route's reason", () => {
    renderPanel({ routeVerdict: { available: false, reason: "runtime" } })
    expect(radio(deliveryGroup(), "Original video")).toBeDisabled()
    expect(screen.getByTestId("native-blocked")).toHaveTextContent(
      "Original video isn't available: this model's runtime doesn't accept video files."
    )
  })

  it("disables the original-video option for a GIF even on an open route", () => {
    const base = result()
    renderPanel({
      state: ready({
        result: result({ source: { ...base.source, kind: "gif", mediaType: "image/gif" } }),
      }),
    })
    expect(radio(deliveryGroup(), "Original video")).toBeDisabled()
    expect(screen.getByTestId("native-blocked")).toHaveTextContent(
      "Original video isn't available: a GIF is sent as frames."
    )
  })

  it("holds edits until Apply and sends the normalised settings", async () => {
    const user = userEvent.setup()
    const { onApply } = renderPanel()
    const apply = screen.getByRole("button", { name: "Apply" })
    expect(apply).toBeDisabled()

    await user.click(radio(deliveryGroup(), "Frames"))
    expect(screen.getByText("Separate images: more detail, more tokens")).toBeInTheDocument()
    expect(screen.getByText("Apply to see the result.")).toBeInTheDocument()
    await user.click(
      radio(screen.getByRole("radiogroup", { name: "Pick frames" }), "At scene changes")
    )
    expect(onApply).not.toHaveBeenCalled()

    await user.click(apply)
    expect(onApply).toHaveBeenCalledWith({
      delivery: "frames",
      strategy: "scene",
      // 9 fits the frames bounds (1–12), so switching delivery keeps it.
      frameCount: 9,
      range: null,
    })
  })

  it("moves the frame count with the keyboard", async () => {
    const user = userEvent.setup()
    const { onApply } = renderPanel()
    const slider = screen.getByRole("slider", { name: "Frames" })
    expect(slider).toHaveAttribute("aria-valuemin", "4")
    expect(slider).toHaveAttribute("aria-valuemax", "16")
    slider.focus()
    fireEvent.keyDown(slider, { key: "ArrowRight" })
    await user.click(screen.getByRole("button", { name: "Apply" }))
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ frameCount: 10 }))
  })

  it("resets the controls to the default storyboard without applying", async () => {
    const user = userEvent.setup()
    const settings = { ...DEFAULT_VIDEO_SETTINGS, delivery: "frames" as const, frameCount: 3 }
    const { onApply } = renderPanel({ state: ready({ result: result({ settings }) }) })
    await user.click(screen.getByRole("button", { name: "Reset" }))
    expect(radio(deliveryGroup(), "Storyboard")).toHaveAttribute("aria-checked", "true")
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
  })

  it("re-seeds the controls when the applied settings change underneath", async () => {
    const user = userEvent.setup()
    const { rerender } = renderPanel()
    await user.click(radio(deliveryGroup(), "Frames"))

    const settings = { ...DEFAULT_VIDEO_SETTINGS, strategy: "scene" as const }
    rerender(
      <VideoPreprocessPanel
        filename="clip.mp4"
        state={ready({ result: result({ settings }) })}
        routeVerdict={OPEN}
        onApply={jest.fn()}
      />
    )
    expect(radio(deliveryGroup(), "Storyboard")).toHaveAttribute("aria-checked", "true")
    expect(
      radio(screen.getByRole("radiogroup", { name: "Pick frames" }), "At scene changes")
    ).toHaveAttribute("aria-checked", "true")
  })
})

describe("VideoPreprocessPanel — range", () => {
  it("trims with the keyboard and clears back to the whole clip", async () => {
    const user = userEvent.setup()
    const { onApply } = renderPanel()
    expect(screen.getByText("Whole clip")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Whole clip" })).not.toBeInTheDocument()

    const start = screen.getByRole("slider", { name: "Range start" })
    start.focus()
    fireEvent.keyDown(start, { key: "ArrowRight" })
    expect(screen.getByText("0:00.1 – 0:30.0")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Apply" }))
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: { startSec: 0.1, endSec: 30 } })
    )

    await user.click(screen.getByRole("button", { name: "Whole clip" }))
    // Back to the whole clip: the value says so, and the reset link goes away.
    expect(screen.queryByRole("button", { name: "Whole clip" })).not.toBeInTheDocument()
    expect(screen.getByText("Whole clip")).toBeInTheDocument()
  })

  it("drops a range and locks the slider when the original video cannot be cut", async () => {
    const user = userEvent.setup()
    const settings = { ...DEFAULT_VIDEO_SETTINGS, range: { startSec: 2, endSec: 10 } }
    const { onApply } = renderPanel({
      state: ready({ result: result({ settings, nativeTrimSupported: false }) }),
    })
    expect(screen.getByText("0:02.0 – 0:10.0")).toBeInTheDocument()

    await user.click(radio(deliveryGroup(), "Original video"))
    expect(screen.getByTestId("trim-blocked")).toHaveTextContent(
      "Cutting a clip for the original-video option needs ffmpeg in the desktop app."
    )
    expect(screen.getByRole("slider", { name: "Range start" })).toHaveAttribute("data-disabled", "")
    await user.click(screen.getByRole("button", { name: "Apply" }))
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: "native", range: null })
    )
  })

  it("keeps the range for the original video when ffmpeg can cut it", async () => {
    const user = userEvent.setup()
    const settings = { ...DEFAULT_VIDEO_SETTINGS, range: { startSec: 2, endSec: 10 } }
    renderPanel({ state: ready({ result: result({ settings, nativeTrimSupported: true }) }) })
    await user.click(radio(deliveryGroup(), "Original video"))
    expect(screen.queryByTestId("trim-blocked")).not.toBeInTheDocument()
    expect(screen.getByText("0:02.0 – 0:10.0")).toBeInTheDocument()
  })
})

describe("VideoPreprocessPanel — progress and errors", () => {
  it("locks the controls and shows progress while a run is in flight", () => {
    const state: StagedAttachmentState = {
      status: "extracting",
      sizeBytes: 0,
      video: { settings: DEFAULT_VIDEO_SETTINGS, result: result(), progress: 0.42 },
    }
    renderPanel({ state })
    expect(screen.getByRole("button", { name: "Processing…" })).toBeDisabled()
    expect(screen.getByRole("progressbar", { name: "Sampling frames…" })).toBeInTheDocument()
    expect(radio(deliveryGroup(), "Frames")).toBeDisabled()
  })

  it("controls stay inert before the first result lands", () => {
    renderPanel({
      state: {
        status: "extracting",
        sizeBytes: 0,
        video: { settings: DEFAULT_VIDEO_SETTINGS, progress: 0 },
      },
    })
    expect(
      screen.queryByRole("region", { name: "What the model receives" })
    ).not.toBeInTheDocument()
    expect(screen.getByRole("slider", { name: "Range start" })).toHaveAttribute("data-disabled", "")
  })

  it.each([
    [
      { reason: "too-large", ffmpeg: "not-tried" },
      "This video is too large to process here (limit 500 MB).",
    ],
    [
      { reason: "undecodable", ffmpeg: "missing" },
      "The app can't decode this format and ffmpeg isn't installed. Install ffmpeg, or convert the video to MP4.",
    ],
    [
      { reason: "undecodable", ffmpeg: "failed" },
      "Neither the app nor ffmpeg could decode this video.",
    ],
    [
      { reason: "undecodable", ffmpeg: "not-available-here" },
      "This device can't decode this video. Open it in the desktop app, or convert it to MP4.",
    ],
    [{ reason: "failed", ffmpeg: "not-tried" }, "Processing failed: boom"],
  ] as const)("explains %o and retries with the applied settings", async (error, message) => {
    const user = userEvent.setup()
    const settings = { ...DEFAULT_VIDEO_SETTINGS, frameCount: 6 }
    const { onApply } = renderPanel({
      state: {
        status: "rejected",
        sizeBytes: 0,
        video: { settings, error: { ...error, message: "boom" } },
      },
    })
    expect(screen.getByRole("alert")).toHaveTextContent(message)
    await user.click(screen.getByRole("button", { name: "Try again" }))
    expect(onApply).toHaveBeenCalledWith(settings)
  })
})
