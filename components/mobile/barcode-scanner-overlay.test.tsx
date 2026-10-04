import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BarcodeScannerOverlay } from "./barcode-scanner-overlay"
import { openBarcodeScanView } from "@/lib/capacitor/barcode-scan-session"
import { dismissTopmostOverlayOnBack } from "@/hooks/ui/use-back-dismiss"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

describe("BarcodeScannerOverlay", () => {
  it("renders accessible scanning controls and restores background and focus on close", async () => {
    const trigger = document.createElement("button")
    document.body.append(trigger)
    trigger.focus()
    document.body.style.background = "red"
    document.documentElement.classList.add("existing-theme")
    const { unmount } = render(<BarcodeScannerOverlay />)
    let view!: ReturnType<typeof openBarcodeScanView>
    await act(async () => { view = openBarcodeScanView({ onCancel: jest.fn() }) })
    expect(screen.getByRole("dialog", { name: "title" })).toBeInTheDocument()
    expect(document.body).toHaveClass("nativePreview")
    expect(document.documentElement).toHaveClass("nativePreview")
    expect(screen.queryByRole("button", { name: "torchOn" })).not.toBeInTheDocument()
    await act(async () => { view.close() })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(document.body).not.toHaveClass("nativePreview")
    expect(document.body.style.background).toBe("red")
    expect(document.documentElement).toHaveClass("existing-theme")
    await waitFor(() => expect(trigger).toHaveFocus())
    unmount()
    trigger.remove()
    document.body.style.background = ""
    document.documentElement.classList.remove("existing-theme")
  })

  it("cancels once using the visible control", async () => {
    render(<BarcodeScannerOverlay />)
    const onCancel = jest.fn()
    await act(async () => { openBarcodeScanView({ onCancel }) })
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("uses the existing Android back dismissal path", async () => {
    render(<BarcodeScannerOverlay />)
    const onCancel = jest.fn()
    await act(async () => { openBarcodeScanView({ onCancel }) })
    await act(async () => { expect(dismissTopmostOverlayOnBack()).toBe(true) })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("cancels and releases preview styling on host unmount", async () => {
    const { unmount } = render(<BarcodeScannerOverlay />)
    const onCancel = jest.fn()
    await act(async () => { openBarcodeScanView({ onCancel }) })
    unmount()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(document.body).not.toHaveClass("nativePreview")
  })

  it("shows torch state and handles torch failure without closing", async () => {
    render(<BarcodeScannerOverlay />)
    const onToggleTorch = jest.fn(async () => { throw new Error("unavailable") })
    let view!: ReturnType<typeof openBarcodeScanView>
    await act(async () => { view = openBarcodeScanView({ onCancel: jest.fn(), onToggleTorch }) })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "torchOn" })) })
    expect(screen.getByRole("status")).toHaveTextContent("torchError")
    await act(async () => { view.setTorch(true) })
    expect(screen.getByRole("button", { name: "torchOff" })).toHaveAttribute("aria-pressed", "true")
    await act(async () => { view.close() })
  })
})
