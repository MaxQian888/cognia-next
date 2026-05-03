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
const useSkillsMock = jest.fn()
jest.mock("@/lib/ccswitch/hooks", () => ({
  useCcswitchStatus: (...args: unknown[]) => useStatusMock(...args),
  useCcswitchSkills: (...args: unknown[]) => useSkillsMock(...args),
}))

const importMock = jest.fn()
jest.mock("@/lib/ccswitch/import", () => ({
  importCcswitchSkills: (...args: unknown[]) => importMock(...args),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { CcswitchSkillsTab } from "./skills-tab"

const skills = [
  { id: "s1", name: "review", content: "# review\ndo it" },
  { id: "s2", name: "external", content: "", sourcePath: "/tmp/x.md" },
]

beforeEach(() => {
  jest.resetAllMocks()
  isTauriMock.mockReturnValue(true)
  useStatusMock.mockReturnValue({
    data: {
      dbPath: "/x",
      exists: true,
      counts: { providers: 0, mcpServers: 0, prompts: 0, skills: 2 },
    },
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  useSkillsMock.mockReturnValue({
    data: skills,
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  importMock.mockResolvedValue({ imported: 1, skipped: [], errored: [] })
})

describe("CcswitchSkillsTab", () => {
  it("renders both rows but flags external-file rows", () => {
    render(<CcswitchSkillsTab />)
    expect(screen.getByText("review")).toBeInTheDocument()
    expect(screen.getByText("external")).toBeInTheDocument()
    expect(screen.getByText("skills.externalBadge")).toBeInTheDocument()
  })

  it("import only sends inline-content rows", async () => {
    render(<CcswitchSkillsTab />)
    fireEvent.click(screen.getByRole("button", { name: /skills\.importBtn/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalled())
    const picks = importMock.mock.calls[0][0]
    expect(picks).toHaveLength(1)
    expect(picks[0].id).toBe("s1")
  })

  it("disables the import button when nothing inline is selected", () => {
    useSkillsMock.mockReturnValue({
      data: [{ id: "s2", name: "external", content: "" }],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchSkillsTab />)
    const btn = screen.getByRole("button", { name: /skills\.importBtn/ })
    expect(btn).toBeDisabled()
  })

  it("renders empty state when CCSwitch has no skills", () => {
    useSkillsMock.mockReturnValue({
      data: [],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchSkillsTab />)
    expect(screen.getByText("skills.emptyTitle")).toBeInTheDocument()
  })
})
