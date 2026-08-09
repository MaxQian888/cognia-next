/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockResourcesRef: { current: import("@cognia/agent-config-types").SkillResource[] } = {
  current: [],
}
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue?: unknown) =>
    defaultValue === 0 ? 0 : mockResourcesRef.current,
}))

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => <button onClick={onSelect}>{children}</button>,
}))

const serializeSkillBundleMock: jest.Mock = jest.fn(async () => ({
  filename: "cite-sources.zip",
  bytes: new Uint8Array([1, 2, 3]),
}))
const saveBinaryFileAsMock: jest.Mock = jest.fn(async () => true)
const saveFileAsMock: jest.Mock = jest.fn(async () => true)
jest.mock("@/lib/skills/bundle/serializer", () => ({
  serializeSkillBundle: (...args: unknown[]) => serializeSkillBundleMock(...args),
}))
jest.mock("@/lib/files/file-bridge", () => ({
  saveBinaryFileAs: (...args: unknown[]) => saveBinaryFileAsMock(...args),
  saveFileAs: (...args: unknown[]) => saveFileAsMock(...args),
}))

// MarkdownRenderer pulls in react-markdown + the full renderer suite +
// next/dynamic; stub it so this test isolates the SkillDetail header/tabs.
jest.mock("@/components/chat/markdown-renderer", () => ({
  __esModule: true,
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}))

const updateOneMock = jest.fn(async () => undefined)
jest.mock("@/hooks/skills", () => ({
  useSkillValidation: jest.fn(),
  useSkillUpdate: () => ({
    statuses: {},
    checkAll: jest.fn(),
    updateOne: updateOneMock,
    checking: false,
    updatingId: null,
    hasUpdate: () => false,
  }),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("./skill-resource-manager", () => ({
  SkillResourceManager: () => <div data-testid="resource-manager" />,
}))

jest.mock("./skill-security-scanner", () => ({
  SkillSecurityScanner: () => <div data-testid="security-scanner" />,
}))

jest.mock("./skill-sync-section", () => ({
  SkillSyncSection: () => <div data-testid="sync-section" />,
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SkillDetail } from "./skill-detail"
import { useSkillsStore } from "@/stores/skills"
import type { Skill } from "@cognia/agent-config-types"

const skill = {
  id: "s1",
  name: "Cite sources",
  description: "Cite all sources inline.",
  content: "...",
  source: "custom",
  status: "enabled",
  createdAt: 0,
  updatedAt: 0,
} as Skill

describe("SkillDetail", () => {
  beforeEach(() => {
    mockResourcesRef.current = []
    serializeSkillBundleMock.mockClear()
    saveBinaryFileAsMock.mockClear()
    saveFileAsMock.mockClear()
  })

  it("the single Edit button jumps to the workspace editor (no separate form dialog)", () => {
    render(<SkillDetail skill={skill} />)
    const editButton = screen.getByTestId("skill-open-in-editor")
    // Merged into one entry labeled "Edit" — there is no second "open in editor" button.
    expect(editButton).toHaveTextContent("card.edit")
    expect(screen.queryByText("card.openInEditor")).not.toBeInTheDocument()
    fireEvent.click(editButton)
    const state = useSkillsStore.getState()
    expect(state.activeTab).toBe("editor")
    expect(state.editorWorkspace.activeSkillId).toBe("s1")
    expect(state.editorWorkspace.openFiles[0]?.draftContent).toBe("...")
  })

  it("disables the Edit button for built-in skills", () => {
    render(<SkillDetail skill={{ ...skill, isBuiltIn: true } as Skill} />)
    expect(screen.getByTestId("skill-open-in-editor")).toBeDisabled()
  })

  it("renders the skill name and description in the header", () => {
    render(<SkillDetail skill={skill} />)
    expect(screen.getByText("Cite sources")).toBeInTheDocument()
    expect(screen.getByText("Cite all sources inline.")).toBeInTheDocument()
  })

  it("renders all five detail tabs in the TabsList", () => {
    render(<SkillDetail skill={skill} />)
    expect(screen.getByText("tabOverview")).toBeInTheDocument()
    expect(screen.getByText("tabContent")).toBeInTheDocument()
    expect(screen.getByText("tabResources")).toBeInTheDocument()
    expect(screen.getByText("tabSecurity")).toBeInTheDocument()
    expect(screen.getByText("tabValidation")).toBeInTheDocument()
  })

  it("hides the update banner when the skill has no pending update", () => {
    act(() => useSkillsStore.setState({ updateAvailable: {} }))
    render(<SkillDetail skill={skill} />)
    expect(screen.queryByTestId("skill-update-banner")).not.toBeInTheDocument()
  })

  it("shows the update banner and runs the one-click update when flagged", async () => {
    act(() => useSkillsStore.setState({ updateAvailable: { s1: true } }))
    render(<SkillDetail skill={skill} />)
    expect(screen.getByTestId("skill-update-banner")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("skill-update-button"))
    await waitFor(() => expect(updateOneMock).toHaveBeenCalledWith(skill))
    act(() => useSkillsStore.setState({ updateAvailable: {} }))
  })

  it("exports a standard bundle with the localized zip filter", async () => {
    render(<SkillDetail skill={{ ...skill, slug: "cite-sources" } as Skill} />)
    fireEvent.click(screen.getByText("exportBundle"))

    await waitFor(() => expect(serializeSkillBundleMock).toHaveBeenCalledTimes(1))
    expect(saveBinaryFileAsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultName: "cite-sources.zip",
        mimeType: "application/zip",
        filters: [{ name: "bundleFilterName", extensions: ["zip"] }],
      })
    )
  })

  it("warns which bundle content compatibility Markdown would omit", () => {
    mockResourcesRef.current = [
      { id: "r1", skillId: "s1", path: "assets/icon.png", name: "icon.png" },
    ] as never
    render(
      <SkillDetail
        skill={{ ...skill, slug: "cite-sources", codexOpenAiYaml: "interface: {}" } as Skill}
      />
    )
    fireEvent.click(screen.getByText("exportMarkdownCompatibility"))

    expect(screen.getByText("compatibilityExportTitle")).toBeInTheDocument()
    expect(screen.getByText('compatibilityExportResources:{"count":1}')).toBeInTheDocument()
    expect(screen.getByText("compatibilityExportCodex")).toBeInTheDocument()
    expect(saveFileAsMock).not.toHaveBeenCalled()
  })
})
