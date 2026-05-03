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
