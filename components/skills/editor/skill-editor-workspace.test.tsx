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

import { fireEvent, render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillEditorWorkspace } from "./skill-editor-workspace"

beforeEach(() => {
  skillRef.current = undefined
  resourcesRef.current = []
  liveQueryIdx = 0
  mobileRef.current = false
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

  it("on mobile, swaps Monaco for the plain-textarea editor", () => {
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
    expect(screen.getByTestId("skill-plain-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
    // Edits flow through the same draft-content store path.
    fireEvent.change(screen.getByTestId("skill-plain-editor"), {
      target: { value: "edited body" },
    })
    expect(
      useSkillsStore.getState().editorWorkspace.openFiles.find((f) => f.id === "main")?.draftContent
    ).toBe("edited body")
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
})
