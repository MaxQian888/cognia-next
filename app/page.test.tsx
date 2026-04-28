import { render, screen } from "@testing-library/react"
import Home from "./page"

describe("Home Page", () => {
  it("renders the Next.js logo", () => {
    render(<Home />)
    const logo = screen.getByAltText("Next.js logo")
    expect(logo).toBeInTheDocument()
  })

  it("renders the main heading", () => {
    render(<Home />)
    const heading = screen.getByRole("heading", {
      name: /to get started, edit the page\.tsx file/i,
    })
    expect(heading).toBeInTheDocument()
  })

  it("renders the description text", () => {
    render(<Home />)
    const description = screen.getByText(/looking for a starting point/i)
    expect(description).toBeInTheDocument()
  })

  it("renders the Templates link", () => {
    render(<Home />)
    const templatesLink = screen.getByRole("link", { name: /templates/i })
    expect(templatesLink).toBeInTheDocument()
    expect(templatesLink).toHaveAttribute("href", expect.stringContaining("vercel.com/templates"))
  })

  it("renders the Learning link", () => {
    render(<Home />)
    const learningLink = screen.getByRole("link", { name: /learning/i })
    expect(learningLink).toBeInTheDocument()
    expect(learningLink).toHaveAttribute("href", expect.stringContaining("nextjs.org/learn"))
  })

  it("renders the Deploy Now button", () => {
    render(<Home />)
    const deployButton = screen.getByRole("link", { name: /deploy now/i })
    expect(deployButton).toBeInTheDocument()
    expect(deployButton).toHaveAttribute("href", expect.stringContaining("vercel.com/new"))
    expect(deployButton).toHaveAttribute("target", "_blank")
    expect(deployButton).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("renders the Documentation button", () => {
    render(<Home />)
    const docsButton = screen.getByRole("link", { name: /documentation/i })
    expect(docsButton).toBeInTheDocument()
    expect(docsButton).toHaveAttribute("href", expect.stringContaining("nextjs.org/docs"))
    expect(docsButton).toHaveAttribute("target", "_blank")
    expect(docsButton).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("renders the Vercel logomark", () => {
    render(<Home />)
    const vercelLogo = screen.getByAltText("Vercel logomark")
    expect(vercelLogo).toBeInTheDocument()
  })

  it("has correct layout structure", () => {
    const { container } = render(<Home />)
    const main = container.querySelector("main")
    expect(main).toBeInTheDocument()
    expect(main).toHaveClass("flex", "min-h-screen")
  })

  it("applies dark mode classes", () => {
    const { container } = render(<Home />)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass("dark:bg-black")
  })
})
