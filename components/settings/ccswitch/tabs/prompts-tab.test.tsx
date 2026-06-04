/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const useStatusMock = jest.fn()
const usePromptsMock = jest.fn()
jest.mock("@/lib/ccswitch/hooks", () => ({
  useCcswitchStatus: (...args: unknown[]) => useStatusMock(...args),
  useCcswitchPrompts: (...args: unknown[]) => usePromptsMock(...args),
}))

const importMock = jest.fn()
jest.mock("@/lib/ccswitch/import", () => ({
  importCcswitchPrompts: (...args: unknown[]) => importMock(...args),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { CcswitchPromptsTab } from "./prompts-tab"

beforeEach(() => {
  jest.resetAllMocks()
  isTauriMock.mockReturnValue(true)
  useStatusMock.mockReturnValue({
    data: {
      dbPath: "/x",
      exists: true,
      counts: { providers: 0, mcpServers: 0, prompts: 1, skills: 0 },
    },
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  usePromptsMock.mockReturnValue({
    data: [{ id: "q1", name: "Code review", content: "review the code" }],
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  importMock.mockResolvedValue({ imported: 1, errored: [] })
})

describe("CcswitchPromptsTab", () => {
  it("renders prompt rows", async () => {
    render(<CcswitchPromptsTab />)
    expect(await screen.findByText("Code review")).toBeInTheDocument()
  })

  it("import forwards the selected prompts", async () => {
    render(<CcswitchPromptsTab />)
    await screen.findByText("Code review")
    fireEvent.click(screen.getByRole("button", { name: /prompts\.importBtn/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalled())
    expect(importMock.mock.calls[0][0]).toHaveLength(1)
  })

  it("treats same-id prompts from different apps as independent rows", async () => {
    // CCSwitch's prompts table is keyed by (id, app_type) — the id alone
    // repeats across apps, so keys and selection must not collide.
    usePromptsMock.mockReturnValue({
      data: [
        { id: "default", name: "Claude Prompt", content: "a", kind: "claude" },
        { id: "default", name: "Codex Prompt", content: "b", kind: "codex" },
      ],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      render(<CcswitchPromptsTab />)
      await screen.findByText("Claude Prompt")

      const dupKeyError = errorSpy.mock.calls.find((call) => String(call[0]).includes("same key"))
      expect(dupKeyError).toBeUndefined()

      // Both rows start selected; unchecking the first must not uncheck the second.
      const boxes = screen.getAllByRole("checkbox")
      expect(boxes).toHaveLength(2)
      fireEvent.click(boxes[0])
      await waitFor(() => expect(boxes[0]).not.toBeChecked())
      expect(boxes[1]).toBeChecked()

      // Import only sends the prompt that stayed selected.
      fireEvent.click(screen.getByRole("button", { name: /prompts\.importBtn/ }))
      await waitFor(() => expect(importMock).toHaveBeenCalled())
      expect(importMock.mock.calls[0][0]).toHaveLength(1)
      expect(importMock.mock.calls[0][0][0].name).toBe("Codex Prompt")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("renders empty state when CCSwitch has no prompts", () => {
    usePromptsMock.mockReturnValue({
      data: [],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchPromptsTab />)
    expect(screen.getByText("prompts.emptyTitle")).toBeInTheDocument()
  })
})
