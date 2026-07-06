/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}))

jest.mock("@/lib/canvas/monaco-loader", () => ({
  configureMonacoLoader: jest.fn(),
}))

jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (v: string | undefined) => void }) => (
    <textarea data-testid="monaco" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  loader: { config: jest.fn() },
}))

const skillRef: { current: import("@/lib/claude/types").Skill | undefined } = {
  current: undefined,
}
const resourcesRef: { current: import("@/lib/claude/types").SkillResource[] } = {
  current: [],
}
let liveQueryIdx = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => {
    const idx = liveQueryIdx++
    return idx % 2 === 0 ? skillRef.current : resourcesRef.current
  },
}))

jest.mock("@/lib/db/skills", () => ({
  getSkill: async () => skillRef.current,
  updateSkill: jest.fn(),
}))
jest.mock("@/lib/db/skill-resources", () => ({
  listResourcesForSkill: async () => resourcesRef.current,
  updateResource: jest.fn(),
}))

const mobileRef = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileRef.current,
}))

// The CM6 light editor needs DOM-measurement shims in jsdom — stub it with a
// textarea that honours the same value/onChange contract so the store-path
// assertion stays behavioral.
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="light-code-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

// The metadata form (and its streamdown/AI deps) is exercised by
// skill-editor.test.tsx; here we only verify the settings panel wiring, so stub
// SkillEditor with a save button that echoes a metadata-only draft.
jest.mock("../skill-editor", () => ({
  SkillEditor: ({
    hideContent,
    onSave,
  }: {
    hideContent?: boolean
    onSave: (d: unknown) => Promise<void>
  }) => (
    <div data-testid="skill-editor-stub" data-hide-content={String(Boolean(hideContent))}>
      <button
        data-testid="settings-save"
        onClick={() =>
          void onSave({
            name: "Renamed",
            description: "d",
            content: "SHOULD NOT PERSIST",
            category: "custom",
            tags: ["t"],
            allowedTools: ["Read"],
            version: "2",
            author: "a",
            license: "MIT",
          })
        }
      >
        save
      </button>
    </div>
  ),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { updateSkill } from "@/lib/db/skills"
import { SkillEditorWorkspace } from "./skill-editor-workspace"

const updateSkillMock = updateSkill as jest.Mock

beforeEach(() => {
  skillRef.current = undefined
  resourcesRef.current = []
  liveQueryIdx = 0
  mobileRef.current = false
  updateSkillMock.mockClear()
  useSkillsStore.setState({
    editorWorkspace: {
      activeSkillId: null,
      openFiles: [],
      activeFileId: null,
      rightPaneOpen: true,
    },
  } as never)
})

describe("SkillEditorWorkspace", () => {
  it("renders the empty state when no skill is open", () => {
    render(<SkillEditorWorkspace />)
    expect(screen.getByText("emptyPickSkill")).toBeInTheDocument()
  })

  it("renders the file tree + editor when a skill is loaded", () => {
    skillRef.current = {
      id: "s1",
      name: "Test",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    } as never
    useSkillsStore.getState().openSkillInEditor("s1", "body")
    render(<SkillEditorWorkspace />)
    // SKILL.md appears multiple times — desktop file tree + tab strip + mobile sheet body.
    expect(screen.getAllByText("SKILL.md").length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId("monaco")).toBeInTheDocument()
  })

  it("on mobile, swaps Monaco for the CodeMirror light editor", () => {
    mobileRef.current = true
    skillRef.current = {
      id: "s1",
      name: "Test",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    } as never
    useSkillsStore.getState().openSkillInEditor("s1", "body")
    render(<SkillEditorWorkspace />)
    expect(screen.getByTestId("light-code-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
    // Edits flow through the same draft-content store path.
    fireEvent.change(screen.getByTestId("light-code-editor"), {
      target: { value: "edited body" },
    })
    expect(
      useSkillsStore.getState().editorWorkspace.openFiles.find((f) => f.id === "main")?.draftContent
    ).toBe("edited body")
  })

  it("desktop renders the resizable three-pane layout with persisted ids", () => {
    skillRef.current = {
      id: "s1",
      name: "Test",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    } as never
    useSkillsStore.getState().openSkillInEditor("s1", "body")
    render(<SkillEditorWorkspace />)
    expect(screen.getByTestId("skill-files")).toBeInTheDocument()
    expect(screen.getByTestId("skill-editor")).toBeInTheDocument()
    expect(screen.getByTestId("skill-validation")).toBeInTheDocument()
  })

  it("hides the validation pane (and its handle) when the right pane is closed", () => {
    skillRef.current = {
      id: "s1",
      name: "Test",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    } as never
    useSkillsStore.getState().openSkillInEditor("s1", "body")
    useSkillsStore.setState((s) => ({
      editorWorkspace: { ...s.editorWorkspace, rightPaneOpen: false },
    }))
    render(<SkillEditorWorkspace />)
    expect(screen.queryByTestId("skill-validation")).not.toBeInTheDocument()
    expect(screen.getByTestId("skill-editor")).toBeInTheDocument()
  })

  it("opens an AlertDialog when closing a dirty tab and discards on confirm", () => {
    skillRef.current = {
      id: "s1",
      name: "Test",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    } as never
    useSkillsStore.getState().openSkillInEditor("s1", "body")
    useSkillsStore.getState().updateDraftContent("main", "modified body")
    render(<SkillEditorWorkspace />)
    // The first close button in the tab strip belongs to main (file path "SKILL.md").
    fireEvent.click(screen.getAllByLabelText("closeTab:" + JSON.stringify({ path: "SKILL.md" }))[0])
    // AlertDialog renders the localized title + body keys via the next-intl mock.
    expect(screen.getByText("closeDirtyTitle")).toBeInTheDocument()
    // Discard removes the open file.
    fireEvent.click(screen.getByText("closeDirtyDiscard"))
    expect(useSkillsStore.getState().editorWorkspace.openFiles).toHaveLength(0)
  })

  it("keeps the file open when the user cancels the close-dirty dialog", () => {
    skillRef.current = {
      id: "s1",
      name: "Test",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    } as never
    useSkillsStore.getState().openSkillInEditor("s1", "body")
    useSkillsStore.getState().updateDraftContent("main", "modified body")
    render(<SkillEditorWorkspace />)
    fireEvent.click(screen.getAllByLabelText("closeTab:" + JSON.stringify({ path: "SKILL.md" }))[0])
    fireEvent.click(screen.getByText("closeDirtyKeep"))
    expect(useSkillsStore.getState().editorWorkspace.openFiles).toHaveLength(1)
  })

  it("opens the Skill settings panel and saves metadata only, never the body", async () => {
    skillRef.current = {
      id: "s1",
      name: "Test",
      content: "body",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    } as never
    useSkillsStore.getState().openSkillInEditor("s1", "body")
    render(<SkillEditorWorkspace />)
    // The sidebar header exposes the "Skill settings" entry.
    fireEvent.click(screen.getAllByLabelText("openSettings")[0])
    // Reuses SkillEditor in metadata-only mode.
    expect(screen.getByTestId("skill-editor-stub")).toHaveAttribute("data-hide-content", "true")
    fireEvent.click(screen.getByTestId("settings-save"))
    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    const [id, patch] = updateSkillMock.mock.calls[0]
    expect(id).toBe("s1")
    expect(patch).toMatchObject({ name: "Renamed", category: "custom", allowedTools: ["Read"] })
    // The body stays owned by the Monaco tab — settings must never write content.
    expect(patch).not.toHaveProperty("content")
  })
})
