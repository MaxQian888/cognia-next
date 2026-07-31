import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { HomePage } from "./home-page"

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: jest.fn() }),
}))

jest.mock("motion/react", () => ({
  useReducedMotion: () => true,
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
}))

describe("HomePage", () => {
  it("renders all eight sections in the order the spec fixes", () => {
    render(<HomePage locale="en" />)
    const headings = screen
      .getAllByRole("heading", { level: 1 })
      .concat(screen.getAllByRole("heading", { level: 2 }))
      .map((h) => h.textContent)

    const expected = [
      en.home.hero.title,
      en.home.signature.title,
      en.home.workbench.title,
      en.home.desktop.title,
      en.home.run.title,
      en.home.connections.title,
      en.home.trust.title,
      en.home.finalCta.title,
    ]
    for (const title of expected) {
      expect(headings).toContain(title)
    }
  })

  it("advances one signature task, never a second scenario", () => {
    render(<HomePage locale="en" />)
    expect(screen.getByText(en.home.signature.task)).toBeInTheDocument()
  })

  it("wraps the page in the shared shell", () => {
    render(<HomePage locale="en" />)
    // Two navigation landmarks, each named: the site header and the reading
    // position rail. Both are genuinely sets of links for getting somewhere,
    // which is what the role is for — so they are queried by name rather than
    // collapsed into one.
    expect(screen.getByRole("navigation", { name: en.nav.productMenu.label })).toBeInTheDocument()
    expect(screen.getByRole("navigation", { name: en.nav.sectionIndexLabel })).toBeInTheDocument()
    expect(screen.getByRole("contentinfo")).toBeInTheDocument()
  })

  it("indexes every section it renders, with a live anchor for each", () => {
    // The rail, the ids and the labels are one fact: a section that gains an
    // id but no label — or a label with no section — shows up here.
    const { container } = render(<HomePage locale="en" />)
    const rail = screen.getByRole("navigation", { name: en.nav.sectionIndexLabel })
    for (const [id, label] of Object.entries(en.home.sectionIndex)) {
      const link = within(rail).getByRole("link", { name: label })
      expect(link).toHaveAttribute("href", `#${id}`)
      expect(container.querySelector(`#${id}`)).toBeInTheDocument()
    }
  })

  it("keeps the language switcher on the homepage route", () => {
    render(<HomePage locale="en" />)
    expect(screen.getAllByRole("link", { name: "中文" })[0]).toHaveAttribute("href", "/zh")
  })

  it("renders the Chinese homepage end to end", () => {
    render(<HomePage locale="zh" />)
    expect(screen.getByRole("heading", { level: 1, name: zh.home.hero.title })).toBeInTheDocument()
    expect(screen.getByText(zh.home.signature.task)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: zh.home.finalCta.title })).toBeInTheDocument()
  })
})
