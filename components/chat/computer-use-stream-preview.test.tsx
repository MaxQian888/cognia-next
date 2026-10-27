import { fireEvent, render, screen } from "@testing-library/react"
import { useSandboxDesktopStream } from "@/hooks/automation/use-sandbox-desktop-stream"
import { ComputerUseStreamPreview } from "./computer-use-stream-preview"

jest.mock("@/hooks/automation/use-sandbox-desktop-stream", () => ({
  useSandboxDesktopStream: jest.fn(),
}))
const stream = useSandboxDesktopStream as jest.Mock

beforeEach(() => stream.mockReturnValue({ grant: null, status: "idle", attachFrame: jest.fn() }))

it("requests an authenticated observer only when active and keeps screenshot fallback while connecting", () => {
  const { rerender } = render(<ComputerUseStreamPreview connectionId="sandbox" active={false} />)
  expect(stream).toHaveBeenLastCalledWith("sandbox", false, expect.any(Object))
  stream.mockReturnValue({
    grant: { url: "http://127.0.0.1/view", role: "viewer" },
    status: "connecting",
    attachFrame: jest.fn(),
  })
  rerender(<ComputerUseStreamPreview connectionId="sandbox" active />)
  expect(stream).toHaveBeenLastCalledWith("sandbox", true, expect.any(Object))
  const frame = screen.getByTitle("Live Computer Use preview")
  expect(frame).toHaveClass("opacity-0")
  expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin")
  expect(frame).toHaveAttribute("tabindex", "-1")
  stream.mockReturnValue({
    grant: { url: "http://127.0.0.1/view", role: "viewer" },
    status: "open",
    attachFrame: jest.fn(),
  })
  rerender(<ComputerUseStreamPreview connectionId="sandbox" active />)
  expect(frame).toHaveClass("opacity-100")
  expect(screen.getByText("Live")).toBeInTheDocument()
})

it("does not embed an elevated control grant", () => {
  stream.mockReturnValue({
    grant: { url: "http://127.0.0.1/control", role: "controller" },
    status: "open",
    attachFrame: jest.fn(),
  })
  const { container } = render(<ComputerUseStreamPreview connectionId="sandbox" active />)
  expect(container.querySelector("iframe")).toBeNull()
})

it("keeps legacy streams behind the screenshot until load and reports unavailable preview without a frame", () => {
  const ready = jest.fn()
  stream.mockReturnValue({
    grant: { url: "http://127.0.0.1/view", role: "viewer" },
    status: "unmonitored",
    attachFrame: jest.fn(),
  })
  const { rerender } = render(
    <ComputerUseStreamPreview connectionId="sandbox" active onReadyChange={ready} />
  )
  const frame = screen.getByTitle("Live Computer Use preview")
  expect(frame).toHaveClass("opacity-0")
  fireEvent.load(frame)
  expect(frame).toHaveClass("opacity-100")
  expect(ready).toHaveBeenLastCalledWith(true)
  stream.mockReturnValue({ grant: null, status: "unavailable", attachFrame: jest.fn() })
  rerender(<ComputerUseStreamPreview connectionId="sandbox" active onReadyChange={ready} />)
  expect(screen.getByText("Preview unavailable")).toBeInTheDocument()
  expect(ready).toHaveBeenLastCalledWith(false)
})
