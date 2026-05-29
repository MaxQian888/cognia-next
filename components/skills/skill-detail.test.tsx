/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))

// MarkdownRenderer pulls in react-markdown + the full renderer suite +
// next/dynamic; stub it so this test isolates the SkillDetail header/tabs.
jest.mock("@/components/chat/markdown-renderer", () => ({
  __esModule: true,
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}))

jest.mock("@/hooks/skills", () => ({
  useSkillValidation: jest.fn(),
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

import { render, screen } from "@testing-library/react"
import { SkillDetail } from "./skill-detail"
import type { Skill } from "@/lib/claude/types"

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
})
