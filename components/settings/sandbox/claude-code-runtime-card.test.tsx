import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { AppSettings } from "@cognia/agent-config-types"

import sandboxMessages from "@/i18n/messages/en/settings/sandbox.json"

jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn() }))
jest.mock("@/stores/settings", () => {
  const { create } = jest.requireActual("zustand")
  return {
    useSettingsStore: create((set: (state: { settings: unknown }) => void) => ({
      settings: null,
      save: async (patch: unknown) => {
        const next = await jest.requireMock("@/lib/db/settings").saveSettings(patch)
        set({ settings: next })
      },
    })),
  }
})

import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"
import { ClaudeCodeRuntimeCard } from "./claude-code-runtime-card"

const mockSave = saveSettings as jest.MockedFunction<typeof saveSettings>
let persistedSettings: AppSettings
let saveTail: Promise<unknown>
let holdNextSave: Promise<void> | undefined

function renderCard(runtime?: Record<string, unknown>) {
  if (runtime) {
    persistedSettings = {
      ...persistedSettings,
      claudeCodeRuntime: runtime as AppSettings["claudeCodeRuntime"],
    }
  }
  useSettingsStore.setState({ settings: persistedSettings })
  return render(
    <NextIntlClientProvider locale="en" messages={{ settings: { sandbox: sandboxMessages } }}>
      <ClaudeCodeRuntimeCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  persistedSettings = { id: "singleton" } as AppSettings
  saveTail = Promise.resolve()
  holdNextSave = undefined
  mockSave.mockReset()
  // Match saveSettings' existing contract: evaluate functional patches only
  // after preceding writes finish, against the then-current persisted row.
  mockSave.mockImplementation((input) => {
    const hold = holdNextSave
    holdNextSave = undefined
    const next = saveTail.then(async () => {
      await hold
      const patch = typeof input === "function" ? input(persistedSettings) : input
      persistedSettings = { ...persistedSettings, ...patch }
      return persistedSettings
    })
    saveTail = next.catch(() => undefined)
    return next
  })
  useSettingsStore.setState({ settings: null })
})

describe("ClaudeCodeRuntimeCard", () => {
  it("preserves both queued preferences when a pending save outlives the mounted card", async () => {
    let finishSave!: () => void
    holdNextSave = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    const firstView = renderCard()
    await userEvent.click(screen.getByRole("switch", { name: "Request nested user namespaces" }))
    firstView.unmount()

    renderCard()
    await userEvent.click(screen.getByRole("switch", { name: "Enable unattended retry" }))
    expect(mockSave).toHaveBeenCalledTimes(2)
    await act(async () => {
      finishSave()
      await saveTail
    })

    expect(persistedSettings.claudeCodeRuntime).toEqual({
      allowNestedUserNamespaces: true,
      unattendedRetry: { enabled: true, maxWaitMs: 1_800_000, usageLimitRecheckMs: 60_000 },
    })
    expect(useSettingsStore.getState().settings).toEqual(persistedSettings)
  })

  it("merges independent retry fields against the latest row after a remount", async () => {
    let finishSave!: () => void
    holdNextSave = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    const firstView = renderCard({
      unattendedRetry: { enabled: true, maxWaitMs: 1_800_000, usageLimitRecheckMs: 60_000 },
    })
    const maximum = screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" })
    fireEvent.change(maximum, { target: { value: "45" } })
    fireEvent.blur(maximum)
    firstView.unmount()

    renderCard()
    const recheck = screen.getByRole("spinbutton", {
      name: "Usage-limit recheck interval (minutes)",
    })
    fireEvent.change(recheck, { target: { value: "2" } })
    fireEvent.blur(recheck)
    await act(async () => {
      finishSave()
      await saveTail
    })

    expect(persistedSettings.claudeCodeRuntime?.unattendedRetry).toEqual({
      enabled: true,
      maxWaitMs: 2_700_000,
      usageLimitRecheckMs: 120_000,
    })
  })

  it("blocks a second nested preference edit until the first save has completed", async () => {
    let finishSave!: () => void
    holdNextSave = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    renderCard({ unattendedRetry: { enabled: true } })
    const namespaces = screen.getByRole("switch", { name: "Request nested user namespaces" })
    const retry = screen.getByRole("switch", { name: "Enable unattended retry" })

    act(() => {
      fireEvent.click(namespaces)
      fireEvent.click(retry)
    })

    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(namespaces).toBeDisabled()
    expect(retry).toBeDisabled()
    expect(
      screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" })
    ).toBeDisabled()

    await act(async () => {
      finishSave()
      await saveTail
    })
    expect(persistedSettings.claudeCodeRuntime).toMatchObject({
      allowNestedUserNamespaces: true,
      unattendedRetry: { enabled: true },
    })
    expect(namespaces).toBeEnabled()
    expect(retry).toBeEnabled()
  })

  it("catches failed writes, keeps the saved preferences, and allows a retry", async () => {
    mockSave.mockRejectedValueOnce(new Error("settings write failed"))
    renderCard()
    const namespaces = screen.getByRole("switch", { name: "Request nested user namespaces" })
    await userEvent.click(namespaces)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save Claude Code runtime preferences. Try again."
    )
    expect(namespaces).not.toBeChecked()
    expect(namespaces).toBeEnabled()
    expect(screen.getByRole("switch", { name: "Enable unattended retry" })).not.toBeChecked()

    await userEvent.click(namespaces)
    expect(mockSave).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
  })

  it("publishes the returned settings so controlled inputs receive the persisted state", async () => {
    renderCard()
    await userEvent.click(screen.getByRole("switch", { name: "Enable unattended retry" }))
    expect(useSettingsStore.getState().settings?.claudeCodeRuntime).toEqual({
      unattendedRetry: { enabled: true, maxWaitMs: 1_800_000, usageLimitRecheckMs: 60_000 },
    })
  })

  it("defaults both opt-ins off and displays finite retry defaults", () => {
    renderCard()
    expect(screen.getByRole("switch", { name: "Request nested user namespaces" })).not.toBeChecked()
    expect(screen.getByRole("switch", { name: "Enable unattended retry" })).not.toBeChecked()
    expect(
      screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" })
    ).toHaveValue(30)
    expect(
      screen.getByRole("spinbutton", { name: "Usage-limit recheck interval (minutes)" })
    ).toHaveValue(1)
    expect(
      screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" })
    ).toBeDisabled()
  })

  it("explains per-run authorization, host scope, and the weakened file boundary", () => {
    renderCard()
    expect(screen.getByText(/Linux and WSL2 hosts/)).toBeVisible()
    expect(screen.getByText(/protected and credential files/)).toBeVisible()
    expect(screen.getByText(/explicit approval for each run/)).toBeVisible()
    expect(screen.getByRole("switch", { name: "Request nested user namespaces" })).toBeEnabled()
  })

  it("requests namespaces without granting authorization and preserves retry preferences", async () => {
    renderCard({
      unattendedRetry: { enabled: true, maxWaitMs: 600_000, usageLimitRecheckMs: 120_000 },
    })
    await userEvent.click(screen.getByRole("switch", { name: "Request nested user namespaces" }))
    expect(persistedSettings.claudeCodeRuntime).toEqual({
      allowNestedUserNamespaces: true,
      unattendedRetry: { enabled: true, maxWaitMs: 600_000, usageLimitRecheckMs: 120_000 },
    })
  })

  it("enables retries with finite defaults while retaining the namespace request", async () => {
    renderCard({ allowNestedUserNamespaces: true })
    await userEvent.click(screen.getByRole("switch", { name: "Enable unattended retry" }))
    expect(persistedSettings.claudeCodeRuntime).toEqual({
      allowNestedUserNamespaces: true,
      unattendedRetry: { enabled: true, maxWaitMs: 1_800_000, usageLimitRecheckMs: 60_000 },
    })
  })

  it("describes the whole-invocation deadline and runtime availability limits", () => {
    renderCard()
    expect(screen.getByText(/normal work and all retries/)).toBeVisible()
    expect(screen.getByText(/unattended Claude Agent SDK turns/)).toBeVisible()
    expect(screen.getByText(/Router \+ Fusion/)).toBeVisible()
    expect(screen.getByText(/Cancel stops the active invocation and its retry wait/)).toBeVisible()
  })

  it.each([
    ["Maximum invocation time (minutes)", "45", { maxWaitMs: 2_700_000 }],
    ["Usage-limit recheck interval (minutes)", "2", { usageLimitRecheckMs: 120_000 }],
  ])("persists valid minutes as milliseconds for %s", async (name, value, expected) => {
    renderCard({ allowNestedUserNamespaces: false, unattendedRetry: { enabled: true } })
    const input = screen.getByRole("spinbutton", { name })
    fireEvent.change(input, { target: { value } })
    expect(mockSave).not.toHaveBeenCalled()
    fireEvent.blur(input)
    await waitFor(() => {
      expect(persistedSettings.claudeCodeRuntime).toEqual({
        allowNestedUserNamespaces: false,
        unattendedRetry: { enabled: true, ...expected },
      })
    })
    await waitFor(() => expect(screen.getByRole("spinbutton", { name })).toBeEnabled())
  })

  it.each(["", "0", "-1", "181", "1.5", "Infinity"])(
    "rejects an invalid minute input %p without persisting it",
    (value) => {
      renderCard({ unattendedRetry: { enabled: true } })
      const input = screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" })
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
      expect(mockSave).not.toHaveBeenCalled()
      expect(input).toHaveAttribute("aria-invalid", "true")
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number from 1 to 180.")
    }
  )

  it("normalizes imported non-finite durations before persisting an enabled policy", async () => {
    renderCard({ unattendedRetry: { enabled: false, maxWaitMs: Infinity, usageLimitRecheckMs: 0 } })
    expect(
      screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" })
    ).toHaveValue(30)
    expect(
      screen.getByRole("spinbutton", { name: "Usage-limit recheck interval (minutes)" })
    ).toHaveValue(1)
    await userEvent.click(screen.getByRole("switch", { name: "Enable unattended retry" }))
    expect(persistedSettings.claudeCodeRuntime).toEqual({
      unattendedRetry: { enabled: true, maxWaitMs: 1_800_000, usageLimitRecheckMs: 60_000 },
    })
  })

  it("allows the displayed default to repair a malformed duration in an active policy", async () => {
    renderCard({ unattendedRetry: { enabled: true, maxWaitMs: 0 } })
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" }))
    await waitFor(() => {
      expect(persistedSettings.claudeCodeRuntime?.unattendedRetry?.maxWaitMs).toBe(1_800_000)
    })
  })

  it("displays and preserves valid fractional-minute durations when enabling retry", async () => {
    renderCard({
      unattendedRetry: { enabled: false, maxWaitMs: 90_000, usageLimitRecheckMs: 75_000 },
    })
    expect(
      screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" })
    ).toHaveValue(1.5)
    expect(
      screen.getByRole("spinbutton", { name: "Usage-limit recheck interval (minutes)" })
    ).toHaveValue(1.25)

    await userEvent.click(screen.getByRole("switch", { name: "Enable unattended retry" }))
    expect(persistedSettings.claudeCodeRuntime?.unattendedRetry).toEqual({
      enabled: true,
      maxWaitMs: 90_000,
      usageLimitRecheckMs: 75_000,
    })
    mockSave.mockClear()
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Maximum invocation time (minutes)" }))
    expect(mockSave).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
