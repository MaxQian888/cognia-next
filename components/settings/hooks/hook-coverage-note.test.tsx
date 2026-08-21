/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { HOOK_UNCOVERED_SURFACES } from "@/lib/claude/hooks/capabilities"
import { HookCoverageNote } from "./hook-coverage-note"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("HookCoverageNote", () => {
  it("names every uncovered surface", () => {
    render(<HookCoverageNote />)
    // The card exists so a hook author finds out here rather than by watching a
    // hook fail to fire — a surface missing from the list defeats that.
    for (const surface of HOOK_UNCOVERED_SURFACES) {
      expect(screen.getByTestId(`hook-uncovered-${surface.id}`)).toBeInTheDocument()
    }
  })

  it("renders one row per declared surface and no more", () => {
    const { container } = render(<HookCoverageNote />)
    expect(container.querySelectorAll("li")).toHaveLength(HOOK_UNCOVERED_SURFACES.length)
  })

  it("points each surface at a real source path", () => {
    // The code comment at each of these sites points back at this card; a stale
    // path here means the two halves of the label have drifted.
    for (const surface of HOOK_UNCOVERED_SURFACES) {
      expect(surface.source).toMatch(/^(hooks|lib)\/.+\.tsx?$/)
    }
  })
})
