/** @jest-environment jsdom */
import { render } from "@testing-library/react"

import { GuideBrandMesh } from "./guide-brand-mesh"

describe("GuideBrandMesh", () => {
  it("paints the two brand stops from the shared tokens", () => {
    const { container } = render(<GuideBrandMesh />)
    const mesh = container.firstElementChild as HTMLElement
    expect(mesh.style.backgroundImage).toContain("var(--brand-mesh-from)")
    expect(mesh.style.backgroundImage).toContain("var(--brand-mesh-to)")
  })

  it("is decoration only — hidden from assistive tech and from the pointer", () => {
    const { container } = render(<GuideBrandMesh />)
    const mesh = container.firstElementChild as HTMLElement
    expect(mesh).toHaveAttribute("aria-hidden")
    expect(mesh).toHaveClass("pointer-events-none", "absolute", "inset-0")
  })

  it("sits on the app's own opaque background", () => {
    // The wallpaper layer is a fixed body::before; the mesh must not let it
    // show through behind the narration.
    const { container } = render(<GuideBrandMesh className="extra" />)
    expect(container.firstElementChild).toHaveClass("bg-background", "extra")
  })
})
