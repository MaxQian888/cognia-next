/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import {
  TokenGroup,
  TOKEN_GROUPS,
  DEFAULT_GROUP_OPEN,
  countGroupFailures,
  partitionInvariant,
  flattenedGroupTokens,
} from "./token-group"
import type { ThemeColors } from "@/types/plugin/plugin"
import type { ContrastAudit } from "@/lib/appearance/contrast-audit"
import { THEME_COLOR_KEYS, defaultThemeColors } from "@/lib/appearance"

const baseAudit: ContrastAudit = { failures: [], totalPairs: 11, failureCount: 0 }

function failure(fg: keyof ThemeColors, bg: keyof ThemeColors): ContrastAudit["failures"][number] {
  return { pair: [fg, bg], ratio: 1.5 }
}

describe("TOKEN_GROUPS partition", () => {
  it("covers every key in THEME_COLOR_KEYS exactly once", () => {
    const { missing, duplicates } = partitionInvariant()
    expect(missing).toEqual([])
    expect(duplicates).toEqual([])
  })

  it("flattened list length equals THEME_COLOR_KEYS length", () => {
    expect(flattenedGroupTokens()).toHaveLength(THEME_COLOR_KEYS.length)
  })

  it("DEFAULT_GROUP_OPEN expands the first three groups and collapses the rest", () => {
    expect(DEFAULT_GROUP_OPEN.surfaceText).toBe(true)
    expect(DEFAULT_GROUP_OPEN.brand).toBe(true)
    expect(DEFAULT_GROUP_OPEN.status).toBe(true)
    expect(DEFAULT_GROUP_OPEN.sidebar).toBe(false)
    expect(DEFAULT_GROUP_OPEN.chart).toBe(false)
    expect(DEFAULT_GROUP_OPEN.workflowNode).toBe(false)
    expect(DEFAULT_GROUP_OPEN.workflowState).toBe(false)
    expect(DEFAULT_GROUP_OPEN.productAccent).toBe(false)
  })

  it("TOKEN_GROUPS ordering is stable and 8 groups long", () => {
    expect(TOKEN_GROUPS).toHaveLength(8)
    expect(TOKEN_GROUPS.map((g) => g.key)).toEqual([
      "surfaceText",
      "brand",
      "status",
      "sidebar",
      "chart",
      "workflowNode",
      "workflowState",
      "productAccent",
    ])
  })
})

describe("countGroupFailures", () => {
  it("returns 0 when audit has no failures", () => {
    expect(countGroupFailures(baseAudit, ["background", "card"])).toBe(0)
  })

  it("counts a failure when either side of the pair is in the group", () => {
    const audit: ContrastAudit = {
      ...baseAudit,
      failures: [failure("foreground", "background")],
      failureCount: 1,
    }
    expect(countGroupFailures(audit, ["background"])).toBe(1)
    expect(countGroupFailures(audit, ["foreground"])).toBe(1)
    expect(countGroupFailures(audit, ["primary"])).toBe(0)
  })

  it("counts a cross-group failure on both sides (intentional)", () => {
    const audit: ContrastAudit = {
      ...baseAudit,
      failures: [failure("foreground", "background")],
      failureCount: 1,
    }
    expect(countGroupFailures(audit, ["foreground"])).toBe(1)
    expect(countGroupFailures(audit, ["background"])).toBe(1)
  })
})

describe("<TokenGroup />", () => {
  const fallback = defaultThemeColors("light")

  function setup(overrides: Partial<React.ComponentProps<typeof TokenGroup>> = {}) {
    const props: React.ComponentProps<typeof TokenGroup> = {
      groupKey: "surfaceText",
      label: "Surface & text",
      tokens: ["background", "card"],
      defaultOpen: true,
      values: { background: "#fefefe" },
      fallback,
      audit: baseAudit,
      tokenLabel: (k) => k,
      swatchAriaLabel: (k) => `${k} swatch`,
      hexAriaLabel: (k) => `${k} hex`,
      auditChipLabel: "Low",
      failureBadgeLabel: (n) => `${n} fail`,
      onChange: jest.fn(),
      ...overrides,
    }
    const utils = render(<TokenGroup {...props} />)
    return { ...utils, props }
  }

  it("renders header label, token count and is open by default when defaultOpen=true", () => {
    setup()
    expect(screen.getByText("Surface & text")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByTestId("token-group-surfaceText-content")).toBeInTheDocument()
    expect(screen.getByTestId("color-token-background-swatch")).toBeInTheDocument()
    expect(screen.getByTestId("color-token-card-swatch")).toBeInTheDocument()
  })

  it("hides the failure badge when audit has no failures", () => {
    setup()
    expect(screen.queryByTestId("token-group-surfaceText-failures")).not.toBeInTheDocument()
  })

  it("renders the failure badge with localised text when audit has failures", () => {
    setup({
      audit: {
        ...baseAudit,
        failures: [failure("foreground", "background")],
        failureCount: 1,
      },
    })
    const badge = screen.getByTestId("token-group-surfaceText-failures")
    expect(badge).toHaveTextContent("1 fail")
  })

  it("renders the per-row audit chip when a row is flagged", () => {
    setup({
      audit: {
        ...baseAudit,
        failures: [failure("foreground", "background")],
        failureCount: 1,
      },
    })
    expect(screen.getByTestId("audit-chip-background")).toBeInTheDocument()
    expect(screen.queryByTestId("audit-chip-card")).not.toBeInTheDocument()
  })

  it("invokes onChange with the right token key when a row changes", () => {
    const onChange = jest.fn()
    setup({ onChange })
    fireEvent.change(screen.getByTestId("color-token-background-hex"), {
      target: { value: "#123456" },
    })
    expect(onChange).toHaveBeenCalledWith("background", "#123456")
  })

  it("collapses when defaultOpen=false (content not visible)", () => {
    setup({ defaultOpen: false })
    // Radix mounts CollapsibleContent but marks data-state=closed and hides it.
    // The trigger keeps a stable test id we can assert on.
    const trigger = screen.getByTestId("token-group-surfaceText-trigger")
    expect(trigger.getAttribute("data-state")).toBe("closed")
  })
})
