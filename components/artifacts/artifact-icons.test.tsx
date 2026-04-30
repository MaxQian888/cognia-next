/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { getArtifactTypeIcon, ARTIFACT_TYPE_ICONS } from "./artifact-icons"
import { ARTIFACT_TYPES } from "@/lib/artifacts"

describe("getArtifactTypeIcon", () => {
  it.each(ARTIFACT_TYPES)("returns a renderable element for %s", (type) => {
    const { container } = render(<>{getArtifactTypeIcon(type)}</>)
    expect(container.firstChild).not.toBeNull()
  })

  it("falls back to Code for unknown types", () => {
    const { container } = render(<>{getArtifactTypeIcon("unknown" as unknown as "code")}</>)
    expect(container.firstChild).not.toBeNull()
  })

  it("ARTIFACT_TYPE_ICONS exposes one entry per type", () => {
    for (const t of ARTIFACT_TYPES) {
      expect(ARTIFACT_TYPE_ICONS).toHaveProperty(t)
    }
  })
})
