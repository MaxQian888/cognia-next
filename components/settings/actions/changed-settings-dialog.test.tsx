/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULTS } from "@/lib/db/settings"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockSettings: Record<string, unknown> = { ...DEFAULTS }
const resetMock = jest.fn().mockResolvedValue(undefined)

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockSettings; resetSettings: typeof resetMock }) => T
  ) => selector({ settings: mockSettings, resetSettings: resetMock }),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }))

import { ChangedSettingsDialog } from "./changed-settings-dialog"

beforeEach(() => {
  resetMock.mockClear()
  toastSuccess.mockClear()
  mockSettings = { ...DEFAULTS }
})

describe("ChangedSettingsDialog", () => {
  it("shows the empty state when nothing diverges from defaults", () => {
    render(<ChangedSettingsDialog open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("changed-settings-empty")).toBeInTheDocument()
  })

  it("shows the empty state when settings have not loaded", () => {
    mockSettings = null as unknown as Record<string, unknown>
    render(<ChangedSettingsDialog open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("changed-settings-empty")).toBeInTheDocument()
  })

  it("resets a whole group", async () => {
    const user = userEvent.setup()
    mockSettings = { ...DEFAULTS, theme: "dark" }
    render(<ChangedSettingsDialog open onOpenChange={jest.fn()} />)
    await user.click(screen.getAllByTestId("changed-group-reset")[0])
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))
    expect((resetMock.mock.calls[0][0] as string[]).length).toBeGreaterThan(0)
  })

  it("lists changed rows grouped by section", () => {
    mockSettings = { ...DEFAULTS, theme: "dark", ttsEnabled: !DEFAULTS.ttsEnabled }
    render(<ChangedSettingsDialog open onOpenChange={jest.fn()} />)
    expect(screen.getAllByTestId("changed-row").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByTestId("changed-group").length).toBeGreaterThanOrEqual(2)
  })

  it("resets a single row", async () => {
    const user = userEvent.setup()
    mockSettings = { ...DEFAULTS, theme: "dark" }
    render(<ChangedSettingsDialog open onOpenChange={jest.fn()} />)
    await user.click(screen.getAllByTestId("changed-row-reset")[0])
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))
    expect(resetMock).toHaveBeenCalledWith(["theme"])
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("resets all shown keys", async () => {
    const user = userEvent.setup()
    mockSettings = { ...DEFAULTS, theme: "dark", language: "zh-CN" }
    render(<ChangedSettingsDialog open onOpenChange={jest.fn()} />)
    await user.click(screen.getByTestId("changed-reset-all"))
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))
    const keys = resetMock.mock.calls[0][0] as string[]
    expect(keys).toEqual(expect.arrayContaining(["theme", "language"]))
  })

  it("closes via the close button", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(<ChangedSettingsDialog open onOpenChange={onOpenChange} />)
    await user.click(screen.getByText("changedReview.close"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("ChangedSettingsDialog — group headings resolve to a nav label", () => {
  // `keyToSection` used to answer with the retired `providers` / `profile`
  // ids, which are absent from `SETTINGS_NAV` — so the heading fell through to
  // rendering the raw section id as user-facing text.
  it("labels a provider change with the ai-connections tab key, not a raw id", () => {
    // `routingFallbackEnabled` is an ai-connections key that lives in DEFAULTS,
    // so flipping it produces a real diff row.
    mockSettings = { ...DEFAULTS, routingFallbackEnabled: !DEFAULTS.routingFallbackEnabled }
    render(<ChangedSettingsDialog open onOpenChange={() => {}} />)
    const headings = screen
      .getAllByTestId("changed-group")
      .map((g) => g.querySelector("h3")?.textContent ?? "")
    expect(headings).toContain("tabs.aiConnections")
    expect(headings).not.toContain("providers")
  })
})
