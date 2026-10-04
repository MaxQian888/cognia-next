/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import MobileAgentPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/hooks/use-settings-patch")
jest.mock("@/hooks/use-biometric-guard")
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))
const mockIsMobile = jest.fn(() => false)
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  isMobile: () => mockIsMobile(),
}))

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

const mockSettings = (settings: Record<string, unknown>) => {
  ;(useSettingsStore as unknown as jest.Mock).mockImplementation(
    (selector: (s: { settings: unknown }) => unknown) => selector({ settings })
  )
  useSettingsStore.getState = jest.fn(() => ({
    settings,
  })) as unknown as typeof useSettingsStore.getState
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsMobile.mockReturnValue(false)
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

  it("does not disable the permission escalation guard when verification is cancelled", async () => {
    mockIsMobile.mockReturnValue(true)
    guardMock.mockResolvedValueOnce({ kind: "blocked", reason: "cancelled" } as never)
    render(<MobileAgentPage />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-escalate-gate"))
    })
    expect(guardMock.mock.calls[0][0]).toMatchObject({ fallthroughWhenUnavailable: false })
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("disables the escalation guard after native verification", async () => {
    mockIsMobile.mockReturnValue(true)
    render(<MobileAgentPage />)
    fireEvent.click(screen.getByTestId("agent-escalate-gate"))
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD, escalatePermissionMode: false },
      })
    )
    expect(guardMock).toHaveBeenCalledTimes(1)
  })

  it("persists the system prompt once, on blur, trimmed", async () => {
    render(<MobileAgentPage />)
    const ta = screen.getByTestId("agent-system-prompt")
    fireEvent.change(ta, { target: { value: "  speak" } })
    fireEvent.change(ta, { target: { value: "  speak plainly  " } })
    expect(updateMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(ta)
    })
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenCalledWith({ defaultSystemPrompt: "speak plainly" })
  })

  it("clears the system prompt to undefined when emptied", async () => {
    mockSettings({
      permissionMode: "default",
      biometricRequiredFor: DEFAULT_BIOMETRIC_GUARD,
      defaultSystemPrompt: "be terse",
    })
    render(<MobileAgentPage />)
    const ta = screen.getByTestId("agent-system-prompt")
    fireEvent.change(ta, { target: { value: "   " } })
    await act(async () => {
      fireEvent.blur(ta)
    })
    expect(updateMock).toHaveBeenCalledWith({ defaultSystemPrompt: undefined })
  })

  it("does not save the system prompt on a blur that changed nothing", async () => {
    mockSettings({
      permissionMode: "default",
      biometricRequiredFor: DEFAULT_BIOMETRIC_GUARD,
      defaultSystemPrompt: "be terse",
    })
    render(<MobileAgentPage />)
    const ta = screen.getByTestId("agent-system-prompt")
    // Tapping in and out used to queue a desktop update carrying the same text.
    fireEvent.focus(ta)
    await act(async () => {
      fireEvent.blur(ta)
    })
    // Edited and put back (modulo surrounding whitespace): still no change.
    fireEvent.change(ta, { target: { value: "be terse!" } })
    fireEvent.change(ta, { target: { value: " be terse " } })
    await act(async () => {
      fireEvent.blur(ta)
    })
    expect(updateMock).not.toHaveBeenCalled()
    expect(ta).toHaveValue("be terse")
  })

  it("does not save the thinking budget on a blur that changed nothing", async () => {
    mockSettings({
      permissionMode: "default",
      biometricRequiredFor: DEFAULT_BIOMETRIC_GUARD,
      defaultMaxThinkingTokens: 8192,
    })
    render(<MobileAgentPage />)
    const input = screen.getByTestId("agent-thinking-input")
    fireEvent.focus(input)
    await act(async () => {
      fireEvent.blur(input)
    })
    fireEvent.change(input, { target: { value: "8000" } })
    fireEvent.change(input, { target: { value: "8192" } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("saves a typed thinking budget once, clamped, on blur or Enter", async () => {
    render(<MobileAgentPage />)
    const input = screen.getByTestId("agent-thinking-input")
    fireEvent.change(input, { target: { value: "9" } })
    fireEvent.change(input, { target: { value: "9000" } })
    expect(updateMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenLastCalledWith({ defaultMaxThinkingTokens: 9000 })

    fireEvent.change(input, { target: { value: "999999" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(updateMock).toHaveBeenLastCalledWith({ defaultMaxThinkingTokens: 64000 })
  })

  it("commits a thinking-slider keyboard step and resets the budget to off", async () => {
    mockSettings({
      permissionMode: "default",
      biometricRequiredFor: DEFAULT_BIOMETRIC_GUARD,
      defaultMaxThinkingTokens: 2048,
    })
    render(<MobileAgentPage />)
    const thumb = screen.getAllByRole("slider")[0]
    await act(async () => {
      fireEvent.keyDown(thumb, { key: "ArrowRight" })
    })
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenLastCalledWith({ defaultMaxThinkingTokens: 3072 })

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-thinking-reset"))
    })
    expect(updateMock).toHaveBeenLastCalledWith({ defaultMaxThinkingTokens: undefined })
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
