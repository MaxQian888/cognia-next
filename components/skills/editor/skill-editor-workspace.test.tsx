/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

import { render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillEditorWorkspace } from "./skill-editor-workspace"

beforeEach(() => {
  skillRef.current = undefined
  resourcesRef.current = []
  liveQueryIdx = 0
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
    // SKILL.md appears twice (file tree + tab strip); both matter.
    expect(screen.getAllByText("SKILL.md").length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId("monaco")).toBeInTheDocument()
  })
})
