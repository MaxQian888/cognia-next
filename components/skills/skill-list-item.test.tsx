/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const tauriRef = { current: false }
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauriRef.current,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillListItem, DEFAULT_LIST_DISPLAY, type SkillListDisplay } from "./skill-list-item"
import { useSkillsStore } from "@/stores/skills/skills-store"
import type { Skill } from "@cognia/agent-config-types"

const display = (over: Partial<SkillListDisplay> = {}): SkillListDisplay => ({
  ...DEFAULT_LIST_DISPLAY,
  ...over,
})

const baseSkill: Skill = {
  id: "s1",
  name: "Cite sources",
  description: "Cite all sources inline.",
  content: "Use [n] style citations.",
  source: "custom",
  status: "enabled",
  createdAt: 0,
  updatedAt: 0,
} as Skill

const handlers = {
  onToggleSelect: jest.fn(),
  onOpen: jest.fn(),
}

beforeEach(() => {
  tauriRef.current = false
  useSkillsStore.setState({ updateAvailable: {} })
  for (const fn of Object.values(handlers)) fn.mockReset()
})

describe("SkillListItem", () => {
  it("renders name and description", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    expect(screen.getByText("Cite sources")).toBeInTheDocument()
    expect(screen.getByText("Cite all sources inline.")).toBeInTheDocument()
  })

  it("invokes onOpen when the row is clicked", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    fireEvent.click(screen.getByText("Cite sources"))
    expect(handlers.onOpen).toHaveBeenCalledWith("s1")
  })

  it("invokes onToggleSelect (not onOpen) when the checkbox is clicked", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    fireEvent.click(screen.getByLabelText('card.selectAria:{"name":"Cite sources"}'))
    expect(handlers.onToggleSelect).toHaveBeenCalledWith("s1")
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it("reflects batch selection state on the checkbox", () => {
    render(<SkillListItem skill={baseSkill} selected={true} active={false} {...handlers} />)
    expect(screen.getByLabelText('card.selectAria:{"name":"Cite sources"}')).toHaveAttribute(
      "data-state",
      "checked"
    )
  })

  it("applies the active highlight to the row button", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={true} {...handlers} />)
    const row = screen.getByText("Cite sources").closest("button")
    expect(row).toHaveClass("border-l-primary")
  })

  it("shows a disabled badge for disabled skills", () => {
    render(
      <SkillListItem
        skill={{ ...baseSkill, status: "disabled" } as Skill}
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByText("status.disabled")).toBeInTheDocument()
  })

  it("shows the sync dot only in Tauri, colored by sync state", () => {
    tauriRef.current = true
    const { rerender } = render(
      <SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />
    )
    expect(screen.getByTestId("skill-sync-dot")).toHaveClass("bg-muted")
    rerender(
      <SkillListItem
        skill={{ ...baseSkill, syncFingerprint: "fp" } as Skill}
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByTestId("skill-sync-dot")).toHaveClass("bg-emerald-500")
    rerender(
      <SkillListItem
        skill={{ ...baseSkill, lastSyncError: "boom" } as Skill}
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByTestId("skill-sync-dot")).toHaveClass("bg-destructive")
  })

  it("shows the update badge when the store flags this skill", () => {
    useSkillsStore.setState({ updateAvailable: { s1: true } })
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    expect(screen.getByTestId("skill-update-badge")).toBeInTheDocument()
  })

  it("hides the update badge for unflagged skills", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    expect(screen.queryByTestId("skill-update-badge")).not.toBeInTheDocument()
  })

  it("shows a validation badge when the skill has validation errors", () => {
    render(
      <SkillListItem
        skill={
          {
            ...baseSkill,
            validationErrors: [{ message: "bad frontmatter" }],
          } as Skill
        }
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByLabelText('validation.cardBadge:{"count":1}')).toBeInTheDocument()
  })

  describe("display preferences", () => {
    it("hides the description when showDescription is off", () => {
      render(
        <SkillListItem
          skill={baseSkill}
          selected={false}
          active={false}
          display={display({ showDescription: false })}
          {...handlers}
        />
      )
      expect(screen.queryByText("Cite all sources inline.")).not.toBeInTheDocument()
    })

    it("renders tag chips when showTags is on", () => {
      render(
        <SkillListItem
          skill={{ ...baseSkill, tags: ["yaml", "docs"] } as Skill}
          selected={false}
          active={false}
          display={display({ showTags: true })}
          {...handlers}
        />
      )
      expect(screen.getByText("yaml")).toBeInTheDocument()
      expect(screen.getByText("docs")).toBeInTheDocument()
    })

    it("renders the source badge when showSource is on", () => {
      render(
        <SkillListItem
          skill={baseSkill}
          selected={false}
          active={false}
          display={display({ showSource: true })}
          {...handlers}
        />
      )
      expect(screen.getByTestId("skill-source-badge")).toBeInTheDocument()
    })

    it("renders the usage count when showUsage is on", () => {
      render(
        <SkillListItem
          skill={{ ...baseSkill, usageCount: 12 } as Skill}
          selected={false}
          active={false}
          display={display({ showUsage: true })}
          {...handlers}
        />
      )
      expect(screen.getByTestId("skill-usage-count")).toHaveTextContent("12")
    })

    it("tightens spacing in compact density", () => {
      render(
        <SkillListItem
          skill={baseSkill}
          selected={false}
          active={false}
          display={display({ density: "compact" })}
          {...handlers}
        />
      )
      const row = screen.getByText("Cite sources").closest("button")
      expect(row).toHaveClass("py-1.5")
    })

    it("renders a grid card variant with the active ring", () => {
      render(
        <SkillListItem
          skill={baseSkill}
          selected={false}
          active={true}
          display={display({ viewMode: "grid" })}
          {...handlers}
        />
      )
      const card = screen.getByText("Cite sources").closest("button")
      expect(card).toHaveClass("ring-primary")
      // Batch selection still works in grid mode.
      fireEvent.click(screen.getByLabelText('card.selectAria:{"name":"Cite sources"}'))
      expect(handlers.onToggleSelect).toHaveBeenCalledWith("s1")
    })

    it("renders an inactive, compact, disabled grid card with a sync dot and opens on click", () => {
      tauriRef.current = true
      render(
        <SkillListItem
          skill={{ ...baseSkill, status: "disabled", usageCount: 4 } as Skill}
          selected={false}
          active={false}
          display={display({
            viewMode: "grid",
            density: "compact",
            showSource: true,
            showUsage: true,
          })}
          {...handlers}
        />
      )
      const card = screen.getByText("Cite sources").closest("button")!
      expect(card).toHaveClass("p-2") // compact grid padding
      expect(card).toHaveClass("opacity-60") // disabled
      expect(card).not.toHaveClass("ring-primary") // inactive → hover branch
      expect(screen.getByTestId("skill-sync-dot")).toBeInTheDocument()
      expect(screen.getByTestId("skill-source-badge")).toBeInTheDocument()
      expect(screen.getByTestId("skill-usage-count")).toHaveTextContent("4")
      fireEvent.click(card)
      expect(handlers.onOpen).toHaveBeenCalledWith("s1")
    })
  })
})
