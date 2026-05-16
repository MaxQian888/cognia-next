/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const resourcesRef: { current: Array<{ path: string; content: string }> } = { current: [] }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => resourcesRef.current,
}))

jest.mock("@/lib/db/skill-resources", () => ({
  listResourcesForSkill: async () => resourcesRef.current,
}))

jest.mock("@/lib/claude/ipc", () => ({
  skillsScanResources: jest.fn(async () => []),
  skillsScanSecurity: jest.fn(async () => []),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

import { render, screen } from "@testing-library/react"
import { SkillSecurityScanner } from "./skill-security-scanner"
import type { Skill } from "@/lib/claude/types"

const skill = { id: "s1", content: "echo hi" } as Skill

describe("SkillSecurityScanner", () => {
  it("renders the localized title and desktop-only hint outside Tauri", () => {
    render(<SkillSecurityScanner skill={skill} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("desktopOnlyHint")).toBeInTheDocument()
  })

  it("disables the scan trigger outside Tauri", () => {
    render(<SkillSecurityScanner skill={skill} />)
    expect(screen.getByText("scan").closest("button")).toBeDisabled()
  })
})
