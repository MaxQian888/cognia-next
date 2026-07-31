/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

const save = jest.fn().mockResolvedValue(undefined)
let storeSettings: Partial<AppSettings> = {}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))
jest.mock("@/stores/settings", () => {
  const hook = (selector: (s: unknown) => unknown) => selector({ settings: storeSettings, save })
  hook.getState = () => ({ settings: storeSettings, save })
  return { useSettingsStore: hook }
})

import { BackgroundPanel, NestingPanel } from "./policy-panels"

beforeEach(() => {
  save.mockClear()
  storeSettings = {}
})

describe("NestingPanel", () => {
  it("stays clean on mount — no bar until something changes", () => {
    render(<NestingPanel />)
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
  })

  it("raises the bar on the first edit and saves the whole branch at once", async () => {
    render(<NestingPanel />)
    await userEvent.click(screen.getByRole("switch", { name: "enabled" }))

    expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "dirty")
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        subagentNesting: {
          enabled: true,
          maxDepth: 2,
          tokenBudget: 0,
          timeoutMs: 0,
          dispatchMaxRetries: 1,
        },
      })
    )
  })

  it("discards back to the stored values", async () => {
    storeSettings = { subagentNesting: { enabled: false, maxDepth: 2 } }
    render(<NestingPanel />)
    await userEvent.click(screen.getByRole("switch", { name: "enabled" }))
    expect(screen.getByRole("switch", { name: "enabled" })).toBeChecked()

    await userEvent.click(screen.getByTestId("unsaved-bar-discard"))
    expect(screen.getByRole("switch", { name: "enabled" })).not.toBeChecked()
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
  })

  it("does NOT lose an in-progress edit when an unrelated save republishes settings", async () => {
    // The defect this refactor exists to kill: the card used to hydrate from
    // the store inside `useEffect(..., [settings])`, so any other write in the
    // app silently reset whatever was being typed here.
    const { rerender } = render(<NestingPanel />)
    await userEvent.click(screen.getByRole("switch", { name: "enabled" }))
    await userEvent.type(screen.getByLabelText("maxDepth"), "4")
    const editedDepth = (screen.getByLabelText("maxDepth") as HTMLInputElement).value
    expect(editedDepth).not.toBe("2")

    act(() => {
      storeSettings = { ...storeSettings, theme: "dark" } as Partial<AppSettings>
    })
    rerender(<NestingPanel />)

    expect((screen.getByLabelText("maxDepth") as HTMLInputElement).value).toBe(editedDepth)
    expect(screen.getByRole("switch", { name: "enabled" })).toBeChecked()
    expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "dirty")
  })
})

describe("BackgroundPanel", () => {
  it("saves both settings branches together", async () => {
    render(<BackgroundPanel />)
    await userEvent.click(screen.getByRole("switch", { name: "autoResume" }))
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const payload = save.mock.calls[0][0]
    expect(payload.backgroundTasks).toEqual({
      autoResumeInterrupted: true,
      maxAutoResumeAttempts: 2,
    })
    expect(payload.agentPermissions.subagentAsks).toBe("surface")
  })

  it("reads agentPermissions at save time so it cannot stomp a sibling key", async () => {
    storeSettings = {
      agentPermissions: { defaultMode: "acceptEdits" },
    } as unknown as Partial<AppSettings>
    render(<BackgroundPanel />)
    await userEvent.click(screen.getByRole("switch", { name: "autoResume" }))

    // Another surface writes a sibling permission key while this draft is open.
    storeSettings = {
      agentPermissions: { defaultMode: "acceptEdits", allowedTools: ["Read"] },
    } as unknown as Partial<AppSettings>

    await userEvent.click(screen.getByTestId("unsaved-bar-save"))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0][0].agentPermissions).toMatchObject({
      defaultMode: "acceptEdits",
      allowedTools: ["Read"],
    })
  })
})
