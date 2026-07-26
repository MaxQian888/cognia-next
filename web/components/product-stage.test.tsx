jest.mock("@web/content/generated/product-shots.json", () => ({
  capturedAt: "2026-07-26T00:00:00.000Z",
  shots: {
    "hero-light-en": { src: "/product/hero-light-en.png", width: 2400, height: 1500 },
    "hero-dark-en": { src: "/product/hero-dark-en.png", width: 2400, height: 1500 },
    "desktop-light-en": { src: "/product/desktop-light-en.png", width: 1600, height: 1000 },
  },
}))

import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { ProductStage } from "./product-stage"

describe("ProductStage with a captured pair", () => {
  it("emits both themes so the class-based theme control can switch them", () => {
    render(<ProductStage section="hero" locale="en" alt="The workspace" />)
    const images = screen.getAllByRole("img", { name: "The workspace" })
    expect(images).toHaveLength(2)
    expect(images[0]).toHaveClass("dark:hidden")
    expect(images[1]).toHaveClass("dark:block")
  })

  it("gives both images intrinsic dimensions so the page does not shift", () => {
    render(<ProductStage section="hero" locale="en" alt="The workspace" />)
    for (const image of screen.getAllByRole("img", { name: "The workspace" })) {
      expect(image).toHaveAttribute("width", "2400")
      expect(image).toHaveAttribute("height", "1500")
    }
  })

  it("defers loading, since no product visual is the first paint", () => {
    render(<ProductStage section="hero" locale="en" alt="The workspace" />)
    for (const image of screen.getAllByRole("img", { name: "The workspace" })) {
      expect(image).toHaveAttribute("loading", "lazy")
    }
  })

  it("renders the caption when given", () => {
    render(
      <ProductStage section="hero" locale="en" alt="The workspace" caption="Running the task" />
    )
    expect(screen.getByText("Running the task")).toBeInTheDocument()
  })
})

describe("ProductStage without a captured pair", () => {
  it("renders a reconstruction rather than a broken image", () => {
    const { container } = render(<ProductStage section="workbench" locale="en" alt="Workbench" />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector('[data-placeholder="product-stage"]')).toBeInTheDocument()
    expect(container.querySelector('[data-reconstruction="frame"]')).toBeInTheDocument()
  })

  it("refuses a half-captured pair rather than showing the light shot in dark mode", () => {
    const { container } = render(<ProductStage section="desktop" locale="en" alt="Desktop shell" />)
    expect(container.querySelector("img")).toBeNull()
  })

  it("still exposes the description to assistive technology", () => {
    render(<ProductStage section="workbench" locale="en" alt="Workbench" />)
    expect(screen.getByRole("img", { name: "Workbench" })).toBeInTheDocument()
  })

  it("says the visual is a reconstruction, so it never passes as a screenshot", () => {
    render(<ProductStage section="workbench" locale="en" alt="Workbench" />)
    expect(screen.getByText(en.reconstruction.note)).toBeInTheDocument()
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("keeps the depicted chrome out of the accessibility tree", () => {
    render(<ProductStage section="workbench" locale="en" alt="Workbench" />)
    // The rail labels are pictures of controls; announcing them would offer a
    // reader affordances that are not there.
    expect(screen.queryByText(en.reconstruction.workbench.rail.chat)).not.toBeNull()
    expect(screen.getByRole("img", { name: "Workbench" })).toBeInTheDocument()
    expect(screen.queryByRole("list")).toBeNull()
  })

  it("renders the desktop crop for the desktop section, not the workbench", () => {
    render(<ProductStage section="desktop" locale="en" alt="Desktop shell" />)
    expect(screen.getByText(en.reconstruction.desktop.paletteLabel)).toBeInTheDocument()
    expect(screen.queryByText(en.reconstruction.workbench.threadLabel)).toBeNull()
  })

  it("falls back for a locale whose captures do not exist, in that locale", () => {
    const { container } = render(<ProductStage section="hero" locale="zh" alt="工作空间" />)
    expect(container.querySelector("img")).toBeNull()
    expect(screen.getByText(zh.reconstruction.note)).toBeInTheDocument()
  })

  it("renders the caption above the reconstruction note when both are present", () => {
    render(
      <ProductStage section="workbench" locale="en" alt="Workbench" caption="Running the task" />
    )
    expect(screen.getByText("Running the task")).toBeInTheDocument()
    expect(screen.getByText(en.reconstruction.note)).toBeInTheDocument()
  })
})

describe("ProductStage tones", () => {
  it("uses the dark execution substrate when asked", () => {
    const { container } = render(
      <ProductStage section="hero" locale="en" alt="The workspace" tone="stage" />
    )
    expect(container.querySelector(".bg-stage")).toBeInTheDocument()
  })

  it("uses the light product surface by default", () => {
    const { container } = render(<ProductStage section="hero" locale="en" alt="The workspace" />)
    expect(container.querySelector(".bg-surface")).toBeInTheDocument()
  })
})
