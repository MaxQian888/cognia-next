/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { TagIcon } from "lucide-react"

import { AboutCard } from "./about-card"

describe("<AboutCard />", () => {
  it("renders the title and children under the given testid", () => {
    render(
      <AboutCard icon={TagIcon} title="Version" testid="c">
        <p>body</p>
      </AboutCard>
    )
    const card = screen.getByTestId("c")
    expect(card).toHaveTextContent("Version")
    expect(card).toHaveTextContent("body")
  })

  it("renders the action slot when provided", () => {
    render(
      <AboutCard icon={TagIcon} title="Version" testid="c" action={<span>act</span>}>
        body
      </AboutCard>
    )
    expect(screen.getByTestId("c")).toHaveTextContent("act")
  })

  it("omits the action slot by default", () => {
    render(
      <AboutCard icon={TagIcon} title="Version" testid="c">
        body
      </AboutCard>
    )
    expect(screen.queryByText("act")).toBeNull()
  })

  it("merges the card and content class overrides", () => {
    render(
      <AboutCard
        icon={TagIcon}
        title="Version"
        testid="c"
        className="xl:col-span-2"
        contentClassName="grid"
      >
        body
      </AboutCard>
    )
    const card = screen.getByTestId("c")
    expect(card).toHaveClass("xl:col-span-2")
    expect(card.querySelector('[data-slot="card-content"]')).toHaveClass("grid")
  })
})
