// ADR-0028 Phase 9 / T5 — AutomationPolicyCard unit tests.

import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(),
  saveSettings: jest.fn(),
}))

import { transport } from "@/lib/tauri"
import { getSettings, saveSettings } from "@/lib/db/settings"

import { AutomationPolicyCard } from "./automation-policy-card"

const mockCall = transport.call as jest.MockedFunction<typeof transport.call>
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>
const mockSaveSettings = saveSettings as jest.MockedFunction<typeof saveSettings>

const MESSAGES = {
  settings: {
    sandbox: {
      automationPolicy: {
        title: "Per-action policy",
        description: "Extra constraints after permission + consent.",
        emptyNote: "No constraints configured.",
        add: "Add row",
        remove: "Remove row",
        rowAriaLabel: "{label} entry {index}",
        regexInvalid: "Invalid regex",
        saveError: "Could not save policy: {error}",
        allowedProcessNames: {
          label: "Allowed processes",
          description: "Case-insensitive process names.",
          placeholder: "Chrome",
        },
        allowedWindowTitlePatterns: {
          label: "Allowed window titles",
          description: "Window title regexes.",
          placeholder: "^VS Code",
        },
        allowedUrlPatterns: {
          label: "Allowed URLs",
          description: "URL regexes.",
          placeholder: "^https://",
        },
        forbiddenScreenRegions: {
          label: "Forbidden screen regions",
          description: "Pixel rectangles.",
          x: "X",
          y: "Y",
          width: "Width",
          height: "Height",
        },
      },
    },
  },
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      <AutomationPolicyCard />
    </NextIntlClientProvider>
  )
}

const EMPTY_POLICY = {
  allowedProcessNames: [],
  allowedWindowTitlePatterns: [],
  allowedUrlPatterns: [],
  forbiddenScreenRegions: [],
}

beforeEach(() => {
  jest.useFakeTimers()
  mockCall.mockReset()
  mockGetSettings.mockReset()
  mockSaveSettings.mockReset()
  mockGetSettings.mockResolvedValue({ id: "singleton" } as unknown as Awaited<
    ReturnType<typeof getSettings>
  >)
  mockSaveSettings.mockResolvedValue({} as Awaited<ReturnType<typeof saveSettings>>)
})

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers()
  })
  jest.useRealTimers()
})

describe("AutomationPolicyCard", () => {
  it("renders the empty-state hint when no constraints are configured", async () => {
    mockCall.mockResolvedValueOnce(EMPTY_POLICY)
    renderCard()
    await waitFor(() => expect(screen.getByTestId("policy-empty-note")).toBeInTheDocument())
    expect(mockCall).toHaveBeenCalledWith("automation_policy_get", {})
  })

  it("hydrates rows from the policy returned by Rust", async () => {
    mockCall.mockResolvedValueOnce({
      allowedProcessNames: ["Chrome"],
      allowedWindowTitlePatterns: ["^Inbox"],
      allowedUrlPatterns: [],
      forbiddenScreenRegions: [],
    })
    renderCard()
    await waitFor(() => {
      const procFieldset = screen.getByTestId("policy-process-names")
      expect(within(procFieldset).getByDisplayValue("Chrome")).toBeInTheDocument()
    })
    const titleFieldset = screen.getByTestId("policy-window-titles")
    expect(within(titleFieldset).getByDisplayValue("^Inbox")).toBeInTheDocument()
  })

  it("flags an invalid regex with aria-invalid + visible message", async () => {
    mockCall.mockResolvedValueOnce(EMPTY_POLICY)
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderCard()
    await waitFor(() => expect(screen.getByTestId("policy-empty-note")).toBeInTheDocument())

    await user.click(screen.getByTestId("policy-window-titles-add"))
    const titleFieldset = screen.getByTestId("policy-window-titles")
    const input = within(titleFieldset).getByRole("textbox")
    // userEvent.type treats `[` as a key descriptor opener — escape with `[[`.
    await user.type(input, "[[invalid")
    // Trigger blur — onBlur stamps the new value into state and the
    // re-render with the now-invalid pattern marks the input invalid.
    await user.tab()
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(within(titleFieldset).getByText("Invalid regex")).toBeInTheDocument()
  })

  it("debounce-saves edits through the IPC + settings store", async () => {
    mockCall
      .mockResolvedValueOnce(EMPTY_POLICY) // initial get
      .mockResolvedValueOnce(undefined) // first save's set
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderCard()
    await waitFor(() => expect(screen.getByTestId("policy-empty-note")).toBeInTheDocument())

    await user.click(screen.getByTestId("policy-process-names-add"))
    const procFieldset = screen.getByTestId("policy-process-names")
    const input = within(procFieldset).getByRole("textbox")
    await user.type(input, "Chrome")
    await user.tab()

    // Trip the debounce.
    await act(async () => {
      jest.advanceTimersByTime(500)
    })

    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledWith({
        automationPolicy: expect.objectContaining({
          allowedProcessNames: ["Chrome"],
        }),
      })
    })
    expect(mockCall).toHaveBeenCalledWith(
      "automation_policy_set",
      expect.objectContaining({
        policy: expect.objectContaining({ allowedProcessNames: ["Chrome"] }),
      })
    )
  })

  it("removes a row via the trash button", async () => {
    mockCall
      .mockResolvedValueOnce({
        ...EMPTY_POLICY,
        allowedProcessNames: ["Chrome", "Firefox"],
      })
      .mockResolvedValue(undefined)
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByDisplayValue(/Chrome|Firefox/)).toHaveLength(2)
    })

    const procFieldset = screen.getByTestId("policy-process-names")
    const removeButtons = within(procFieldset).getAllByRole("button", {
      name: "Remove row",
    })
    await user.click(removeButtons[0])

    await waitFor(() => {
      expect(within(procFieldset).queryByDisplayValue("Chrome")).not.toBeInTheDocument()
    })
    expect(within(procFieldset).getByDisplayValue("Firefox")).toBeInTheDocument()
  })

  it("adds + edits a screen region row", async () => {
    mockCall.mockResolvedValueOnce(EMPTY_POLICY).mockResolvedValue(undefined)
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderCard()
    await waitFor(() => expect(screen.getByTestId("policy-empty-note")).toBeInTheDocument())

    await user.click(screen.getByTestId("policy-screen-regions-add"))
    const regionsFieldset = screen.getByTestId("policy-screen-regions")
    const inputs = within(regionsFieldset).getAllByRole("spinbutton")
    // Order: X, Y, Width, Height.
    expect(inputs).toHaveLength(4)
    await user.clear(inputs[2])
    await user.type(inputs[2], "200")
    await user.tab()

    await act(async () => {
      jest.advanceTimersByTime(500)
    })

    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledWith({
        automationPolicy: expect.objectContaining({
          forbiddenScreenRegions: [{ x: 0, y: 0, width: 200, height: 0 }],
        }),
      })
    })
  })

  it("surfaces a save error when the IPC rejects", async () => {
    mockCall.mockResolvedValueOnce(EMPTY_POLICY).mockRejectedValueOnce(new Error("vault is locked"))
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    renderCard()
    await waitFor(() => expect(screen.getByTestId("policy-empty-note")).toBeInTheDocument())

    await user.click(screen.getByTestId("policy-process-names-add"))
    const procFieldset = screen.getByTestId("policy-process-names")
    await user.type(within(procFieldset).getByRole("textbox"), "Notepad")
    await user.tab()

    await act(async () => {
      jest.advanceTimersByTime(500)
    })

    const errorNode = await screen.findByTestId("policy-save-error")
    expect(errorNode).toHaveTextContent("vault is locked")
  })
})
