/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { OpticalArchiveRow } from "@/lib/db/optical-archives"
import { TooltipProvider } from "@/components/ui/tooltip"
import { OpticalArchiveDialog } from "./optical-archive-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// useLiveQuery returns whatever the test stages; the Dexie helper is never hit.
const mockState: { archive: OpticalArchiveRow | undefined } = { archive: undefined }
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockState.archive }))
jest.mock("@/lib/db/optical-archives", () => ({ getOpticalArchive: jest.fn() }))

const noop = () => {}

// Frames render through `ImageBlock`, whose hover toolbar uses Radix tooltips.
// The app mounts `TooltipProvider` once in `app/layout.tsx`; the test harness
// has to supply it.
function renderDialog(props: { open?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <OpticalArchiveDialog archiveId="compact-1" open={props.open ?? true} onOpenChange={noop} />
    </TooltipProvider>
  )
}

const archive = (over: Partial<OpticalArchiveRow> = {}): OpticalArchiveRow => ({
  id: "compact-1",
  sessionId: "s1",
  createdAt: 1,
  strategy: "optical",
  preTokens: 4000,
  postTokens: 400,
  frameCount: 2,
  frames: [
    { base64: "AAAA", width: 512, height: 64 },
    { base64: "BBBB", width: 512, height: 40 },
  ],
  shape: { font: "8x8", variant: "bw", size: 512 },
  coverage: 1,
  readability: 0.9,
  estImageTokens: 80,
  estTextTokens: 1000,
  originalText: "user: original conversation text",
  ...over,
})

beforeEach(() => {
  mockState.archive = archive()
})

it("renders the frames, token stats, and shape", () => {
  renderDialog()
  // Both frames rendered as data-URI images.
  expect(screen.getByAltText('frameAlt:{"n":1}')).toHaveAttribute(
    "src",
    "data:image/png;base64,AAAA"
  )
  expect(screen.getByAltText('frameAlt:{"n":2}')).toHaveAttribute(
    "src",
    "data:image/png;base64,BBBB"
  )
  // Description carries the frame count; the token + shape stats render.
  expect(screen.getByText('description:{"count":2}')).toBeInTheDocument()
  expect(screen.getByText(/4K/)).toBeInTheDocument()
  expect(screen.getByText(/saved:\{"pct":90\}/)).toBeInTheDocument()
  expect(screen.getByText(/8x8 · bw · 512px/)).toBeInTheDocument()
})

it("makes each frame zoomable — an optical frame is text rendered to pixels", async () => {
  renderDialog()
  await userEvent.click(screen.getByAltText('frameAlt:{"n":2}'))
  // The lightbox opened on the clicked frame, not the first one.
  expect(screen.getByTestId("image-lightbox-stage")).toBeInTheDocument()
  expect(screen.getByText('counter:{"current":2,"total":2}')).toBeInTheDocument()
})

it("reveals and hides the original text on demand", async () => {
  renderDialog()
  expect(screen.queryByText(/original conversation text/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId("optical-reveal-text"))
  expect(screen.getByText(/original conversation text/)).toBeInTheDocument()
  await userEvent.click(screen.getByTestId("optical-reveal-text"))
  expect(screen.queryByText(/original conversation text/)).not.toBeInTheDocument()
})

it("shows a no-text notice when the original was not captured", () => {
  mockState.archive = archive({ originalText: undefined })
  renderDialog()
  expect(screen.getByText("noText")).toBeInTheDocument()
  expect(screen.queryByTestId("optical-reveal-text")).not.toBeInTheDocument()
})

it("omits optional stats when absent (shape without size, no coverage/readability/estimate)", () => {
  mockState.archive = archive({
    shape: { font: "8x8" },
    coverage: undefined,
    readability: undefined,
    estImageTokens: undefined,
    estTextTokens: undefined,
  })
  renderDialog()
  // Shape renders just the font (no size suffix); the optional dt labels are gone.
  expect(screen.getByText("8x8")).toBeInTheDocument()
  expect(screen.queryByText("coverage")).not.toBeInTheDocument()
  expect(screen.queryByText("readability")).not.toBeInTheDocument()
  expect(screen.queryByText("estimate")).not.toBeInTheDocument()
})

it("shows a not-found notice when the archive is gone", () => {
  mockState.archive = undefined
  renderDialog()
  expect(screen.getByText("notFound")).toBeInTheDocument()
})

it("does not query when closed", () => {
  renderDialog({ open: false })
  expect(screen.queryByTestId("optical-archive-dialog")).not.toBeInTheDocument()
})
