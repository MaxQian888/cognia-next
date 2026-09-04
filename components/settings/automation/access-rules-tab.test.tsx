/**
 * @jest-environment jsdom
 *
 * Covers the merged tab. The cases that used to live in
 * `components/settings/sandbox/automation-policy-card.test.tsx` (regex
 * validation, debounced persistence, row removal, screen regions) moved here
 * with the editor, and the admit-stage cases are new.
 *
 * Mocks sit at the two host stores rather than at `access-rules.ts`, so the
 * orchestration that writes both stages is exercised, not stubbed.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"

const settingsGet = jest.fn()
const settingsSet = jest.fn()
const getFocus = jest.fn()
const getAutomationPolicy = jest.fn()
const saveAutomationPolicy = jest.fn()
let tauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    settingsGet: (...a: unknown[]) => settingsGet(...a),
    settingsSet: (...a: unknown[]) => settingsSet(...a),
    getFocus: (...a: unknown[]) => getFocus(...a),
  },
  defaultAutomationSettings: () => ({ whitelist: { processNames: [], windowTitlePatterns: [] } }),
}))

jest.mock("@/lib/automation/policy", () => ({
  getAutomationPolicy: (...a: unknown[]) => getAutomationPolicy(...a),
  saveAutomationPolicy: (...a: unknown[]) => saveAutomationPolicy(...a),
}))

import { AccessRulesTab } from "./access-rules-tab"

const EMPTY_RESTRICT = {
  allowedProcessNames: [],
  allowedWindowTitlePatterns: [],
  allowedUrlPatterns: [],
  forbiddenScreenRegions: [],
}

const hostSettings = (whitelist = { processNames: [], windowTitlePatterns: [] }) => ({
  enabled: true,
  whitelist,
})

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AccessRulesTab />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  tauri = true
  settingsGet.mockResolvedValue(hostSettings())
  settingsSet.mockResolvedValue(undefined)
  getAutomationPolicy.mockResolvedValue({ ...EMPTY_RESTRICT })
  saveAutomationPolicy.mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers()
  })
  jest.useRealTimers()
})

const settle = async () => {
  await waitFor(() => expect(screen.getByTestId("automation-access-rules")).toBeInTheDocument())
}

const tripDebounce = async () => {
  await act(async () => {
    jest.advanceTimersByTime(600)
  })
}

describe("AccessRulesTab", () => {
  it("shows the unavailable notice where no automation engine runs", () => {
    tauri = false
    renderTab()
    expect(screen.getByTestId("automation-unavailable")).toBeInTheDocument()
    expect(settingsGet).not.toHaveBeenCalled()
  })

  /**
   * The point of the merge. Both stages used to be edited from two Settings
   * sections that never mentioned each other.
   */
  it("hydrates both stages from their separate stores into one editor", async () => {
    settingsGet.mockResolvedValue(
      hostSettings({ processNames: ["notepad.exe"], windowTitlePatterns: ["*Excel*"] })
    )
    getAutomationPolicy.mockResolvedValue({
      ...EMPTY_RESTRICT,
      allowedProcessNames: ["Chrome"],
      allowedWindowTitlePatterns: ["^Inbox"],
    })

    renderTab()
    await settle()

    expect(
      within(screen.getByTestId("admit-process-names")).getByText("notepad.exe")
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId("admit-window-titles")).getByText("*Excel*")
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId("restrict-process-names")).getByDisplayValue("Chrome")
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId("restrict-window-titles")).getByDisplayValue("^Inbox")
    ).toBeInTheDocument()
  })

  it("says an empty admit stage admits everything", async () => {
    renderTab()
    await settle()
    expect(screen.getByTestId("admit-empty-note")).toHaveTextContent(
      en.automation.accessRules.admit.emptyNote
    )
  })

  it("writes an added admit entry to the host settings store", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderTab()
    await settle()

    const group = screen.getByTestId("admit-process-names")
    await user.type(within(group).getByRole("textbox"), "code.exe")
    await user.click(
      within(group).getByRole("button", { name: en.automation.accessRules.admit.add })
    )
    await tripDebounce()

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          whitelist: expect.objectContaining({ processNames: ["code.exe"] }),
        })
      )
    )
  })

  it("refuses a duplicate admit entry instead of writing it twice", async () => {
    settingsGet.mockResolvedValue(
      hostSettings({ processNames: ["code.exe"], windowTitlePatterns: [] })
    )
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderTab()
    await settle()

    const group = screen.getByTestId("admit-process-names")
    await user.type(within(group).getByRole("textbox"), "code.exe")
    await user.click(
      within(group).getByRole("button", { name: en.automation.accessRules.admit.add })
    )
    await tripDebounce()

    expect(within(group).getAllByText("code.exe")).toHaveLength(1)
  })

  it("flags an invalid restrict regex", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderTab()
    await settle()

    await user.click(screen.getByTestId("restrict-window-titles-add"))
    const group = screen.getByTestId("restrict-window-titles")
    const input = within(group).getByRole("textbox")
    // userEvent.type treats `[` as a key-descriptor opener, so escape it.
    await user.type(input, "[[invalid")

    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(
      within(group).getByText(en.automation.accessRules.restrict.regexInvalid)
    ).toBeInTheDocument()
  })

  it("debounce-saves a restrict edit through the policy store", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderTab()
    await settle()

    await user.click(screen.getByTestId("restrict-process-names-add"))
    await user.type(
      within(screen.getByTestId("restrict-process-names")).getByRole("textbox"),
      "Chrome"
    )
    await tripDebounce()

    await waitFor(() =>
      expect(saveAutomationPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ allowedProcessNames: ["Chrome"] })
      )
    )
  })

  it("removes a restrict row through its trash button", async () => {
    getAutomationPolicy.mockResolvedValue({
      ...EMPTY_RESTRICT,
      allowedProcessNames: ["Chrome", "Firefox"],
    })
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderTab()
    await settle()

    const group = screen.getByTestId("restrict-process-names")
    const removes = within(group).getAllByRole("button", {
      name: en.automation.accessRules.restrict.remove,
    })
    await user.click(removes[0])

    await waitFor(() => expect(within(group).queryByDisplayValue("Chrome")).not.toBeInTheDocument())
    expect(within(group).getByDisplayValue("Firefox")).toBeInTheDocument()
  })

  it("adds a forbidden screen region with all four axes", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderTab()
    await settle()

    await user.click(screen.getByTestId("restrict-screen-regions-add"))
    const inputs = within(screen.getByTestId("restrict-screen-regions")).getAllByRole("spinbutton")
    expect(inputs).toHaveLength(4)

    await user.clear(inputs[2])
    await user.type(inputs[2], "200")
    await user.tab()
    await tripDebounce()

    await waitFor(() =>
      expect(saveAutomationPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          forbiddenScreenRegions: [expect.objectContaining({ width: 200 })],
        })
      )
    )
  })

  it("prefills the admit inputs from the focused window", async () => {
    getFocus.mockResolvedValue({ processName: "notepad.exe", windowTitle: "Untitled - Notepad" })
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderTab()
    await settle()

    await user.click(
      screen.getByRole("button", { name: en.automation.accessRules.admit.captureFocused })
    )

    await waitFor(() =>
      expect(within(screen.getByTestId("admit-process-names")).getByRole("textbox")).toHaveValue(
        "notepad.exe"
      )
    )
  })
})
