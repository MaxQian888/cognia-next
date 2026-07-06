/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import MobileAgentPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/hooks/use-settings-patch")
jest.mock("@/hooks/use-biometric-guard")
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))

const updateMock = jest.fn(async () => undefined)
const guardMock = jest.fn(async (_gate: unknown, action: () => Promise<unknown>) => {
  await action()
  return { kind: "ok", value: undefined }
})

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

const mockSettings = (settings: Record<string, unknown>) =>
  (useSettingsStore as unknown as jest.Mock).mockImplementation(
    (selector: (s: { settings: unknown }) => unknown) => selector({ settings })
  )

beforeEach(() => {
  jest.clearAllMocks()
  ;(useSettingsPatch as jest.Mock).mockReturnValue(updateMock)
  ;(useBiometricGuard as jest.Mock).mockReturnValue(guardMock)
  mockPaired(true)
  mockSettings({ permissionMode: "default", biometricRequiredFor: DEFAULT_BIOMETRIC_GUARD })
})

describe("MobileAgentPage", () => {
  it("shows the paired placeholder (no controls) when unpaired", () => {
    mockPaired(false)
    render(<MobileAgentPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-permission-mode")).toBeNull()
  })

  it("renders the agent controls when paired", () => {
    render(<MobileAgentPage />)
    expect(screen.getByTestId("agent-permission-mode")).toBeInTheDocument()
    expect(screen.getByTestId("agent-system-prompt")).toBeInTheDocument()
    expect(screen.getByTestId("agent-thinking-slider")).toBeInTheDocument()
    expect(screen.getByTestId("agent-bare-mode")).toBeInTheDocument()
  })

  it("persists a behavior toggle through the settings patch hook", () => {
    render(<MobileAgentPage />)
    fireEvent.click(screen.getByTestId("agent-brief-mode"))
    expect(updateMock).toHaveBeenCalledWith({ briefMode: true })
  })

  it("persists the system prompt on blur (trimmed, undefined when empty)", () => {
    render(<MobileAgentPage />)
    const ta = screen.getByTestId("agent-system-prompt")
    fireEvent.change(ta, { target: { value: "  speak plainly  " } })
    fireEvent.blur(ta)
    expect(updateMock).toHaveBeenCalledWith({ defaultSystemPrompt: "speak plainly" })
  })

  it("biometric-gates a permission-mode escalation before writing", async () => {
    render(<MobileAgentPage />)
    // default → bypassPermissions is an escalation; the guard must run.
    fireEvent.click(screen.getByTestId("agent-permission-mode"))
    fireEvent.click(await screen.findByText("Bypass permissions"))
    expect(guardMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenCalledWith({ permissionMode: "bypassPermissions" })
  })

  it("toggles surfaceSkillsEnabled (defaults on → writes false)", () => {
    render(<MobileAgentPage />)
    expect(screen.getByTestId("agent-surface-skills")).toBeChecked()
    fireEvent.click(screen.getByTestId("agent-surface-skills"))
    expect(updateMock).toHaveBeenCalledWith({ surfaceSkillsEnabled: false })
  })

  it("merge-updates compaction.enabled, preserving sibling keys", () => {
    mockSettings({
      permissionMode: "default",
      biometricRequiredFor: DEFAULT_BIOMETRIC_GUARD,
      compaction: { fraction: 0.8 },
    })
    render(<MobileAgentPage />)
    fireEvent.click(screen.getByTestId("agent-compaction-enabled"))
    expect(updateMock).toHaveBeenCalledWith({ compaction: { fraction: 0.8, enabled: false } })
  })

  it("does not gate a de-escalation to plan mode", async () => {
    mockSettings({
      permissionMode: "bypassPermissions",
      biometricRequiredFor: DEFAULT_BIOMETRIC_GUARD,
    })
    render(<MobileAgentPage />)
    fireEvent.click(screen.getByTestId("agent-permission-mode"))
    fireEvent.click(await screen.findByText("Plan only"))
    expect(guardMock).not.toHaveBeenCalled()
    expect(updateMock).toHaveBeenCalledWith({ permissionMode: "plan" })
  })
})
