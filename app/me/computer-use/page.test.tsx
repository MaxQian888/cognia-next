/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)
const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: { mobileComputerUseEnabled: false },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: Record<string, unknown> | undefined
      save: (patch: Record<string, unknown>) => Promise<void>
    }) => unknown
  ) =>
    selector({
      settings: settingsRef.current,
      save: async (patch: Record<string, unknown>) => {
        if (settingsRef.current) {
          settingsRef.current = { ...settingsRef.current, ...patch }
        }
        await saveMock(patch)
      },
    }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

// The supervision panel has its own suite. Stubbing it keeps this one on the
// master toggle, which is the only thing this page owns.
jest.mock("@/components/mobile/automation/host-automation-panel", () => ({
  HostAutomationPanel: () => <div data-testid="stub-host-automation-panel" />,
}))

import Page from "./page"

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  settingsRef.current = { mobileComputerUseEnabled: false }
})

describe("MobileComputerUsePage", () => {
  it("renders the master toggle and the host supervision panel", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-computer-use-page")).toBeInTheDocument()
    expect(screen.getByTestId("computer-use-master-switch")).toBeInTheDocument()
    expect(screen.getByTestId("stub-host-automation-panel")).toBeInTheDocument()
  })

  it("shows the whole explanation and drops the desktop card frame", () => {
    // The page was a card whose body restated what the switch already showed.
    // Collapsed to a row, the description then hit the primitive's two-line
    // clamp and cut off at "regardless of pe...", hiding the exception the
    // setting exists to explain.
    const { container } = render(<Page />)
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    const description = container.querySelector('[data-slot="item-description"]')
    expect(description?.className).toMatch(/line-clamp-none/)
  })

  it("flipping the master switch writes mobileComputerUseEnabled + enqueues an RPC", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("computer-use-master-switch"))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(saveMock).toHaveBeenCalledWith({ mobileComputerUseEnabled: true })
    // Host mirroring moved out of `useSettingsPatch` and into the persistence
    // funnel (`lib/settings/mirror-to-host.ts`) so it also covers the mobile
    // routes that embed a desktop settings section. Enqueuing here as well
    // would send every edit twice.
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("disables the switch and shows a spinner while the patch is in flight", async () => {
    let release: () => void = () => undefined
    saveMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    render(<Page />)
    const sw = screen.getByTestId("computer-use-master-switch")
    fireEvent.click(sw)

    await waitFor(() => expect(sw).toBeDisabled())
    expect(screen.getByTestId("computer-use-saving")).toBeInTheDocument()

    act(() => release())
    await waitFor(() => expect(sw).not.toBeDisabled())
    expect(screen.queryByTestId("computer-use-saving")).not.toBeInTheDocument()
  })
})
