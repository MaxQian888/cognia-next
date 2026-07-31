import { render, screen } from "@testing-library/react"
import { Interstitial } from "./interstitial"

describe("Interstitial", () => {
  it("renders the statement it exists to carry", () => {
    render(<Interstitial statement="Every step is reviewable." />)
    expect(screen.getByText("Every step is reviewable.")).toBeInTheDocument()
  })

  it("renders the eyebrow and detail when supplied", () => {
    render(<Interstitial eyebrow="Scope" statement="Statement" detail="4 surfaces" />)
    expect(screen.getByText("Scope")).toBeInTheDocument()
    expect(screen.getByText("4 surfaces")).toBeInTheDocument()
  })

  it("is not a landmark", () => {
    // It is the gap between two sections, not a section. Making it a <section>
    // would put it in the rail and in the screen-reader landmark list, both of
    // which imply content it does not have.
    const { container } = render(<Interstitial statement="Statement" />)
    expect(container.querySelector("section")).toBeNull()
  })

  it("carries no heading", () => {
    const { container } = render(<Interstitial eyebrow="Scope" statement="Statement" />)
    expect(container.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull()
  })

  it("holds the index channel open when there is no eyebrow", () => {
    // Without the spacer the statement would slide left and stop lining up with
    // the interstitials that do carry an index.
    const { container } = render(<Interstitial statement="Statement" />)
    const spacer = container.querySelector("div[aria-hidden]")
    expect(spacer).toBeInTheDocument()
    expect(spacer).toHaveClass("md:block")
  })

  it("drops the spacer once the eyebrow occupies the channel", () => {
    const { container } = render(<Interstitial eyebrow="Scope" statement="Statement" />)
    expect(container.querySelector("div[aria-hidden]")).toBeNull()
  })

  it("omits the detail slot entirely when not supplied", () => {
    const { container } = render(<Interstitial statement="Statement" />)
    expect(container.querySelectorAll("p")).toHaveLength(1)
  })

  it("draws a rule above itself", () => {
    // `Hairline` is always aria-hidden, so the rule is findable only in the DOM.
    const { container } = render(<Interstitial statement="Statement" />)
    expect(container.querySelector("[aria-hidden].bg-hairline")).toBeInTheDocument()
  })

  it("stays short: no section-scale vertical padding", () => {
    // The whole value of this component is that it is a fraction of a section's
    // height. If it ever grows a `py-24`-class rhythm it has stopped being a
    // breath and become another section.
    const { container } = render(<Interstitial statement="Statement" />)
    const tokens = container.innerHTML.match(/(?:md:|lg:)?py-\d+/g) ?? []
    for (const token of tokens) {
      expect(Number(token.replace(/^.*py-/, ""))).toBeLessThanOrEqual(12)
    }
  })

  it("merges a caller className onto the outer block", () => {
    const { container } = render(<Interstitial statement="Statement" className="bg-surface" />)
    expect(container.firstElementChild).toHaveClass("bg-surface")
  })
})
