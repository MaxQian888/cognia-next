/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useSkillsStore } from "@/stores/skills"
import { SkillPanelTabs } from "./skill-panel-tabs"

beforeEach(() => {
  useSkillsStore.setState({
    activeTab: "my-skills",
    editorWorkspace: {
      activeSkillId: null,
      openFiles: [],
      activeFileId: null,
      rightPaneOpen: true,
    },
  } as never)
})

describe("SkillPanelTabs", () => {
  it("renders all four tab triggers", () => {
    render(<SkillPanelTabs />)
    expect(screen.getByText("mySkills")).toBeInTheDocument()
    expect(screen.getByText("browse")).toBeInTheDocument()
    expect(screen.getByText("editor")).toBeInTheDocument()
    expect(screen.getByText("analytics")).toBeInTheDocument()
  })

  // Regression: labels must live in a truncating span so a narrow pane shrinks
  // the tabs instead of overflowing into a horizontal scrollbar (whose
  // scroll-into-view on click was the reported tab-switch jitter).
  it("wraps each tab label in a truncating span so narrow panes shrink instead of scrolling", () => {
    const { container } = render(<SkillPanelTabs />)
    const labels = container.querySelectorAll("span.truncate")
    expect([...labels].map((s) => s.textContent)).toEqual([
      "mySkills",
      "browse",
      "editor",
      "analytics",
    ])
  })

  it("writes the new active tab to the store on click", async () => {
    // Radix Tabs listens on the full pointer-down → click sequence. The
    // user-event lib simulates that chain end-to-end whereas fireEvent.click
    // alone is treated as a no-op by Radix in jsdom.
    const user = userEvent.setup()
    render(<SkillPanelTabs />)
    await user.click(screen.getByRole("tab", { name: /browse/ }))
    expect(useSkillsStore.getState().activeTab).toBe("browse")
  })

  it("shows a dirty count badge on the editor tab when files have unsaved changes", () => {
    useSkillsStore.setState({
      editorWorkspace: {
        activeSkillId: "s1",
        openFiles: [
          {
            id: "main",
            kind: "main",
            path: "SKILL.md",
            language: "markdown",
            draftContent: "dirty",
            savedContent: "clean",
          },
        ],
        activeFileId: "main",
        rightPaneOpen: true,
      },
    } as never)
    render(<SkillPanelTabs />)
    expect(screen.getByText("1")).toBeInTheDocument()
  })
})
