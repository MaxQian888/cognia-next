/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const skillRef: { current: unknown } = { current: undefined }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => skillRef.current,
}))

jest.mock("@/lib/db/skills", () => ({
  getSkill: async () => skillRef.current,
}))

// Bypass the heavy SkillDetail render — not under test here.
jest.mock("./skill-detail", () => ({
  SkillDetail: ({ skill }: { skill: { name: string } }) => (
    <div data-testid="skill-detail-stub">{skill.name}</div>
  ),
}))

const mobileRef = { current: true }
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileRef.current,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillDetailPanel } from "./skill-detail-panel"

beforeEach(() => {
  skillRef.current = undefined
  mobileRef.current = true
  useSkillsStore.setState({ detailSkillId: null } as never)
})

describe("SkillDetailPanel", () => {
  it("stays closed when detailSkillId is null", () => {
    render(<SkillDetailPanel />)
    expect(screen.queryByTestId("skill-detail-stub")).not.toBeInTheDocument()
  })

  it("renders a localized loading fallback while the live query resolves", () => {
    useSkillsStore.setState({ detailSkillId: "s1" } as never)
    render(<SkillDetailPanel />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("mounts SkillDetail once the skill loads", () => {
    skillRef.current = { id: "s1", name: "Loaded" }
    useSkillsStore.setState({ detailSkillId: "s1" } as never)
    render(<SkillDetailPanel />)
    expect(screen.getByTestId("skill-detail-stub")).toHaveTextContent("Loaded")
  })

  it("clears the detail target when the sheet is dismissed", () => {
    skillRef.current = { id: "s1", name: "Loaded" }
    useSkillsStore.setState({ detailSkillId: "s1" } as never)
    render(<SkillDetailPanel />)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    expect(useSkillsStore.getState().detailSkillId).toBeNull()
  })

  // On desktop the detail renders inline in the master-detail right pane;
  // the Sheet must never mount so the skill isn't shown twice.
  it("does not mount on desktop even with an active detail target", () => {
    mobileRef.current = false
    skillRef.current = { id: "s1", name: "Loaded" }
    useSkillsStore.setState({ detailSkillId: "s1" } as never)
    const { container } = render(<SkillDetailPanel />)
    expect(screen.queryByTestId("skill-detail-stub")).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })
})
