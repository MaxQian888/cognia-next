/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

type ResourceStub = {
  id: string
  skillId: string
  kind: "script" | "reference" | "asset"
  name: string
  path: string
  content: string
  encoding: "utf-8" | "base64"
  size: number
  createdAt: number
  updatedAt: number
  inline?: boolean
}
const resourcesRef: { current: ResourceStub[] } = { current: [] }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => resourcesRef.current,
}))

jest.mock("@/lib/db/skill-resources", () => ({
  createResource: jest.fn(),
  deleteResource: jest.fn(),
  listResourcesForSkill: async () => resourcesRef.current,
  updateResource: jest.fn(),
}))

const mkResource = (id: string, name: string, path: string): ResourceStub => ({
  id,
  skillId: "s1",
  kind: "script",
  name,
  path,
  content: "",
  encoding: "utf-8",
  size: 0,
  createdAt: 0,
  updatedAt: 0,
})

import { render, screen } from "@testing-library/react"
import { SkillResourceManager } from "./skill-resource-manager"

describe("SkillResourceManager", () => {
  it("renders the localized title", () => {
    resourcesRef.current = []
    render(<SkillResourceManager skillId="s1" />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("renders the empty state when there are no resources", () => {
    resourcesRef.current = []
    render(<SkillResourceManager skillId="s1" />)
    expect(screen.getByText(/emptyState:\{"title":"title"\}/)).toBeInTheDocument()
  })

  it("renders each resource row with its name", () => {
    resourcesRef.current = [
      mkResource("r1", "build.sh", "scripts/build.sh"),
      mkResource("r2", "api.md", "references/api.md"),
    ]
    render(<SkillResourceManager skillId="s1" />)
    expect(screen.getByText("build.sh")).toBeInTheDocument()
    expect(screen.getByText("api.md")).toBeInTheDocument()
  })
})
