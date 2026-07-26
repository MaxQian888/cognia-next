import { render, screen } from "@testing-library/react"
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
    expect(screen.getByRole("navigation")).toBeInTheDocument()
    expect(screen.getByRole("contentinfo")).toBeInTheDocument()
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
