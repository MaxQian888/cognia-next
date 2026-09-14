import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DEFAULT_VIDEO_SETTINGS } from "@/lib/chat/attachments/video/settings"
import type { VideoPreprocessResult } from "@/lib/chat/attachments/video/preprocess"
import { AttachmentPreviewSheet, type PreviewTarget } from "./attachment-preview-sheet"
import type { StagedAttachmentState } from "./staged-attachment-store"

// An open Sheet sets `pointer-events: none` on <body>, and Radix tabs activate
// on mouseDown rather than click.
const user = () => userEvent.setup({ pointerEventsCheck: 0 })

const DOC: PreviewTarget = {
  id: "a",
  filename: "report.pdf",
  mediaType: "application/pdf",
  url: "data:application/pdf;base64,eA==",
}
const IMG: PreviewTarget = {
  id: "i",
  filename: "shot.png",
  mediaType: "image/png",
  url: "blob:shot",
}

function ready(over: Partial<StagedAttachmentState> = {}): StagedAttachmentState {
  return {
    status: "ready",
    sizeBytes: 2048,
    extracted: { kind: "document", block: { type: "text", text: "x" }, tokens: 0 },
    ...over,
  }
}

function renderSheet(props: Partial<React.ComponentProps<typeof AttachmentPreviewSheet>> = {}) {
  return render(
    <TooltipProvider>
      <AttachmentPreviewSheet
        open
        onOpenChange={jest.fn()}
        target={DOC}
        state={ready()}
        videoRoute={{ available: false, reason: "runtime" }}
        onApplyVideoSettings={jest.fn()}
        {...props}
      />
    </TooltipProvider>
  )
}

describe("AttachmentPreviewSheet — header", () => {
  it("titles the panel with the filename and summarises the payload", () => {
    renderSheet({
      state: ready({
        sizeBytes: 2048,
        extracted: { kind: "document", block: { type: "text", text: "x" }, tokens: 310 },
      }),
    })
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "report.pdf" })).toBeInTheDocument()
    expect(within(dialog).getByText(/application\/pdf/)).toHaveTextContent("2.0KB")
    expect(within(dialog).getByText(/310 tokens/)).toBeInTheDocument()
  })

  it("falls back to a generic name when the file has none", () => {
    renderSheet({ target: { id: "x" }, state: undefined })
    expect(screen.getByRole("heading", { name: "attachment" })).toBeInTheDocument()
  })

  it("renders nothing dialog-side when closed", () => {
    renderSheet({ open: false })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("AttachmentPreviewSheet — file tab", () => {
  it("shows the empty state for a target with no url", () => {
    renderSheet({ target: { id: "x", filename: "gone.pdf" } })
    expect(screen.getByText("Nothing was extracted from this file.")).toBeInTheDocument()
  })

  it("renders an image inline with a full-size escape hatch", () => {
    renderSheet({ target: IMG, state: ready() })
    expect(screen.getByAltText("shot.png")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Full size" })).toBeInTheDocument()
  })

  it("opens the shared lightbox from the full-size button", async () => {
    renderSheet({ target: IMG, state: ready() })
    await user().click(screen.getByRole("button", { name: "Full size" }))
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", "blob:shot")
  })

  it("labels a nameless image with the generic fallback in the lightbox", async () => {
    renderSheet({ target: { id: "n", mediaType: "image/png", url: "blob:n" }, state: ready() })
    await user().click(screen.getByRole("button", { name: "Full size" }))
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("alt", "attachment")
  })

  // Documents route to FilePartPreview — the renderer that until now only ever
  // ran for inbound connector messages, never for the user's own attachments.
  it("delegates a PDF to the shared file preview", () => {
    renderSheet()
    expect(screen.getByTestId("file-preview-pdf")).toBeInTheDocument()
  })
})

describe("AttachmentPreviewSheet — model view", () => {
  it("shows the extracted text the model actually receives", async () => {
    renderSheet({
      state: ready({
        extracted: {
          kind: "document",
          block: { type: "text", text: "x" },
          tokens: 5,
          text: 'Attached file "report.pdf":\n\nthe body',
        },
      }),
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByText(/the body/)).toBeInTheDocument()
    expect(screen.getByText("This is exactly what the model receives.")).toBeInTheDocument()
  })

  it("highlights redacted spans and explains them", async () => {
    renderSheet({
      state: ready({
        extracted: {
          kind: "document",
          block: { type: "text", text: "x" },
          tokens: 5,
          text: "Mail <EMAIL_001> today",
        },
      }),
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByTestId("redacted-span")).toHaveTextContent("<EMAIL_001>")
    expect(screen.getByTestId("redaction-note")).toBeInTheDocument()
  })

  it("omits the redaction note when nothing was substituted", async () => {
    renderSheet({
      state: ready({
        extracted: {
          kind: "document",
          block: { type: "text", text: "x" },
          tokens: 5,
          text: "clean prose",
        },
      }),
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.queryByTestId("redaction-note")).not.toBeInTheDocument()
  })

  it("reports progress while the file is still being read", async () => {
    renderSheet({ state: { status: "extracting", sizeBytes: 0 } })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByText("Reading…")).toBeInTheDocument()
  })

  // The panel and the chip describe the same wait, so they show the same
  // indicator — opening the panel mid-wait is visually continuous.
  it("reports an image's wait as analysis, matching its chip", async () => {
    renderSheet({ target: IMG, state: { status: "extracting", sizeBytes: 0 } })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getAllByText("Analyzing image…").length).toBeGreaterThan(0)
    expect(screen.queryByText("Reading…")).not.toBeInTheDocument()
  })

  it("shows the downscale rule and wire size for an image", async () => {
    renderSheet({
      target: IMG,
      state: ready({
        extracted: {
          kind: "image",
          block: null,
          tokens: 0,
          image: { mediaType: "image/png", bytes: 4096 },
        },
      }),
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByTestId("model-view-image")).toBeInTheDocument()
    expect(screen.getByText(/1568px/)).toHaveTextContent("4.0KB")
  })

  it("falls back to the empty state for a document that yielded nothing", async () => {
    renderSheet({
      state: {
        status: "rejected",
        sizeBytes: 10,
        extracted: { kind: "document", block: null, tokens: 0, rejectReason: "empty" },
      },
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByText("Nothing was extracted from this file.")).toBeInTheDocument()
  })
})

describe("AttachmentPreviewSheet — OCR layer", () => {
  const imageState = (over: Partial<StagedAttachmentState> = {}) =>
    ready({
      extracted: { kind: "image", block: null, tokens: 0 },
      ...over,
    })

  it("offers to run OCR when no text exists yet", async () => {
    const onRunOcr = jest.fn()
    renderSheet({ target: IMG, state: imageState(), onRunOcr })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    await user().click(screen.getByRole("button", { name: "Run OCR" }))
    expect(onRunOcr).toHaveBeenCalledWith("i")
  })

  it("disables the trigger and reports progress while OCR runs", async () => {
    renderSheet({ target: IMG, state: imageState(), onRunOcr: jest.fn(), ocrBusy: true })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    const button = screen.getByRole("button", { name: "Running OCR…" })
    expect(button).toBeDisabled()
  })

  // The opt-in is the whole point: OCR text used to be appended to the draft
  // while the image stayed attached, silently sending both.
  it("exposes the send opt-in once text exists", async () => {
    const onToggleIncludeOcr = jest.fn()
    renderSheet({
      target: IMG,
      state: imageState({ ocrText: "recognised words", includeOcr: false }),
      onToggleIncludeOcr,
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByText("recognised words")).toBeInTheDocument()
    const toggle = screen.getByRole("switch")
    expect(toggle).not.toBeChecked()
    await user().click(toggle)
    expect(onToggleIncludeOcr).toHaveBeenCalledWith("i")
  })

  it("hides the follow-up routes when their handlers are absent", async () => {
    renderSheet({ target: IMG, state: imageState({ ocrText: "words" }) })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.queryByRole("button", { name: "View per-page result" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add text to message" })).not.toBeInTheDocument()
  })

  it("wires both follow-up routes when supplied", async () => {
    const onViewOcrDetail = jest.fn()
    const onExtractOcrToInput = jest.fn()
    renderSheet({
      target: IMG,
      state: imageState({ ocrText: "words" }),
      onViewOcrDetail,
      onExtractOcrToInput,
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    await user().click(screen.getByRole("button", { name: "View per-page result" }))
    expect(onViewOcrDetail).toHaveBeenCalled()
    await user().click(screen.getByRole("button", { name: "Add text to message" }))
    expect(onExtractOcrToInput).toHaveBeenCalledWith("i")
  })
})

describe("AttachmentPreviewSheet — videos and GIFs", () => {
  const CLIP: PreviewTarget = {
    id: "v",
    filename: "clip.mp4",
    mediaType: "video/mp4",
    url: "blob:clip",
  }
  const LOOP: PreviewTarget = {
    id: "g",
    filename: "loop.gif",
    mediaType: "image/gif",
    url: "blob:loop",
  }
  const image = { mediaType: "image/jpeg", base64: "AAAA", bytes: 3, width: 16, height: 9 }
  const videoResult: VideoPreprocessResult = {
    engine: "browser",
    source: { kind: "video", mediaType: "video/mp4", durationSec: 12, width: 640, height: 360 },
    settings: DEFAULT_VIDEO_SETTINGS,
    sampled: {
      delivery: "storyboard",
      frames: [{ timeSec: 0.5, reason: "uniform" }],
      images: [image],
      description: "d",
      blocks: [],
      estimatedImageTokens: 90,
    },
    native: null,
    nativeFailure: null,
    nativeTrimSupported: false,
    poster: image,
  }
  const motionReady = (): StagedAttachmentState => ({
    status: "ready",
    sizeBytes: 4096,
    video: { settings: DEFAULT_VIDEO_SETTINGS, result: videoResult },
  })

  it("plays a video from its blob URL in the file tab", () => {
    renderSheet({ target: CLIP, state: motionReady() })
    const player = screen.getByLabelText("Video preview of clip.mp4")
    expect(player.tagName).toBe("VIDEO")
    expect(player).toHaveAttribute("src", "blob:clip")
    expect(screen.queryByTestId("file-preview-pdf")).not.toBeInTheDocument()
  })

  it("puts the sampling controls in the model tab and applies them for this chip", async () => {
    const onApplyVideoSettings = jest.fn()
    renderSheet({
      target: CLIP,
      state: motionReady(),
      videoRoute: { available: true },
      onApplyVideoSettings,
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    const panel = screen.getByTestId("video-preprocess-panel")
    expect(within(panel).getByAltText("Storyboard of clip.mp4")).toBeInTheDocument()
    expect(within(panel).getByRole("radio", { name: "Original video" })).toBeEnabled()

    await user().click(within(panel).getByRole("radio", { name: "Frames" }))
    await user().click(within(panel).getByRole("button", { name: "Apply" }))
    expect(onApplyVideoSettings).toHaveBeenCalledWith(
      "v",
      expect.objectContaining({ delivery: "frames" })
    )
  })

  it("passes the conversation's route verdict through", async () => {
    renderSheet({ target: CLIP, state: motionReady() })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByRole("radio", { name: "Original video" })).toBeDisabled()
    expect(screen.getByTestId("native-blocked")).toHaveTextContent(
      "this model's runtime doesn't accept video files"
    )
  })

  it("shows the panel's progress rather than the document spinner while a video waits", async () => {
    renderSheet({ target: CLIP, state: { status: "extracting", sizeBytes: 0 } })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByTestId("video-preprocess-panel")).toBeInTheDocument()
    expect(screen.queryByText("Reading…")).not.toBeInTheDocument()
  })

  it("treats a GIF the pipeline claimed as motion, and keeps it an animated image in the file tab", async () => {
    const gifResult = {
      ...videoResult,
      engine: "gif" as const,
      source: {
        ...videoResult.source,
        kind: "gif" as const,
        mediaType: "image/gif",
        frameCount: 8,
      },
    }
    renderSheet({
      target: LOOP,
      state: {
        status: "ready",
        sizeBytes: 10,
        video: { settings: DEFAULT_VIDEO_SETTINGS, result: gifResult },
      },
    })
    expect(screen.getByAltText("loop.gif")).toHaveAttribute("src", "blob:loop")
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByTestId("video-preprocess-panel")).toBeInTheDocument()
  })

  it("keeps a GIF the pipeline did not claim on the image path", async () => {
    renderSheet({
      target: LOOP,
      state: ready({ extracted: { kind: "image", block: null, tokens: 0 } }),
    })
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.queryByTestId("video-preprocess-panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("model-view-image")).toBeInTheDocument()
  })
})
