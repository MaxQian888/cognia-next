/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: (m: string) => toastError(m) } }))

jest.mock("@/components/updates/update-center", () => ({
  UpdateCenter: ({ autoCheck }: { autoCheck?: boolean }) => (
    <div data-testid="update-center-stub" data-auto-check={String(Boolean(autoCheck))} />
  ),
}))

const saveMock = jest.fn(async (_patch: Record<string, unknown>) => {})
const settingsState = {
  settings: { updateCenter: { channel: "stable", backgroundDownloadDesktop: false } } as Record<
    string,
    unknown
  >,
  save: saveMock,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState }
  ),
}))

import { UpdatesSection } from "./updates-section"

beforeEach(() => {
  saveMock.mockClear()
  toastError.mockClear()
  settingsState.settings = { updateCenter: { channel: "stable", backgroundDownloadDesktop: false } }
})

describe("UpdatesSection", () => {
  it("mounts the Update Center and checks on open", () => {
    render(<UpdatesSection />)
    expect(screen.getByTestId("update-center-stub")).toHaveAttribute("data-auto-check", "true")
  })

  it("offers only the channels a user may pick", () => {
    render(<UpdatesSection />)
    fireEvent.click(screen.getByTestId("update-channel"))
    expect(screen.queryByText("Canary")).not.toBeInTheDocument()
  })

  it("shows a canary install as beta rather than a blank control", () => {
    settingsState.settings = { updateCenter: { channel: "canary" } }
    render(<UpdatesSection />)
    expect(screen.getByTestId("update-channel")).toHaveTextContent("Beta")
  })

  it("persists the background-download toggle", async () => {
    render(<UpdatesSection />)
    fireEvent.click(screen.getByTestId("update-background-download"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          updateCenter: expect.objectContaining({ backgroundDownloadDesktop: true }),
        })
      )
    )
  })

  it("persists the critical-notice toggle", async () => {
    render(<UpdatesSection />)
    fireEvent.click(screen.getByTestId("update-notify-critical"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          updateCenter: expect.objectContaining({ notifyCritical: false }),
        })
      )
    )
  })

  it("surfaces a save failure instead of silently losing the choice", async () => {
    saveMock.mockRejectedValueOnce(new Error("disk full"))
    render(<UpdatesSection />)
    fireEvent.click(screen.getByTestId("update-background-download"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toContain("disk full")
  })

  it("says background download is desktop-only, so the promise is not overstated", () => {
    render(<UpdatesSection />)
    expect(
      screen.getByText(/Only the signed Cognia desktop package. Everything else always asks first./)
    ).toBeInTheDocument()
  })
})
