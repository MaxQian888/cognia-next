/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import MobileInstructionsPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useSettingsStore } from "@/stores/settings"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/hooks/use-settings-patch")
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const updateMock = jest.fn(async (_patch: Record<string, unknown>) => undefined)

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

const mockSettings = (settings: Record<string, unknown> | undefined) =>
  (useSettingsStore as unknown as jest.Mock).mockImplementation(
    (selector: (s: { settings: unknown }) => unknown) => selector({ settings })
  )

beforeEach(() => {
  jest.clearAllMocks()
  ;(useSettingsPatch as jest.Mock).mockReturnValue(updateMock)
  mockPaired(true)
  mockSettings({ instructions: { enabled: true, mode: "layered", extraPaths: ["a.md"] } })
})

describe("MobileInstructionsPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileInstructionsPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("instructions-save")).toBeNull()
  })

  it("hydrates the form from persisted instructions config", () => {
    render(<MobileInstructionsPage />)
    expect(screen.getByTestId("instructions-enabled")).toBeChecked()
    expect((screen.getByTestId("instructions-extra") as HTMLTextAreaElement).value).toBe("a.md")
  })

  it("saves the assembled InstructionsConfig through the patch hook", async () => {
    render(<MobileInstructionsPage />)
    fireEvent.change(screen.getByTestId("instructions-extra"), {
      target: { value: "one.md\n  two.md  \n" },
    })
    fireEvent.click(screen.getByTestId("instructions-save"))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    const patch = updateMock.mock.calls[0][0] as { instructions: Record<string, unknown> }
    expect(patch.instructions.enabled).toBe(true)
    expect(patch.instructions.extraPaths).toEqual(["one.md", "two.md"])
  })
})
