import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CaptureBubble } from "./capture-bubble"
import { useCaptureStore } from "@/stores/capture/capture-store"
import { persistCapture } from "@/lib/capture/capture-manager"
import { toast } from "sonner"
import type { CaptureCandidate } from "@/types/capture"

jest.mock("@/lib/capture/capture-manager", () => ({ persistCapture: jest.fn() }))
jest.mock("@/lib/capture/enrich", () => ({ buildEnrichDeps: jest.fn(() => ({})) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockPersist = persistCapture as jest.Mock

const candidate: CaptureCandidate = {
  kind: "url",
  text: "https://x.test",
  sourceUrl: "https://x.test",
  sourceApp: "Chrome",
  fingerprint: "fp",
}

beforeEach(() => {
  jest.clearAllMocks()
  act(() => useCaptureStore.getState().clear())
})

describe("CaptureBubble", () => {
  it("renders nothing when there is no pending capture", () => {
    const { container } = render(<CaptureBubble timeoutSec={99} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the candidate preview and source app", () => {
    act(() => useCaptureStore.getState().request(candidate))
    render(<CaptureBubble timeoutSec={99} />)
    expect(screen.getByTestId("capture-bubble")).toBeInTheDocument()
    expect(screen.getByText("https://x.test")).toBeInTheDocument()
    expect(screen.getByText(/Chrome/)).toBeInTheDocument()
  })

  it("saves on confirm and clears", async () => {
    mockPersist.mockResolvedValue({ id: "c1" })
    act(() => useCaptureStore.getState().request(candidate))
    render(<CaptureBubble timeoutSec={99} />)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockPersist).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalled()
    expect(useCaptureStore.getState().pending).toBeNull()
  })

  it("dismisses without saving", async () => {
    act(() => useCaptureStore.getState().request(candidate))
    render(<CaptureBubble timeoutSec={99} />)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(useCaptureStore.getState().pending).toBeNull()
    expect(mockPersist).not.toHaveBeenCalled()
  })
})
