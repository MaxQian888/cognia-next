/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { A2UITemplatePreview } from "./a2ui-template-preview"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
  CardHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card-header" className={className}>
      {children}
    </div>
  ),
  CardTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card-title" className={className}>
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

describe("A2UITemplatePreview", () => {
  describe("empty state", () => {
    it("renders the no-template placeholder when template is undefined", () => {
      render(<A2UITemplatePreview />)
      expect(screen.getByText("noTemplateSelected")).toBeInTheDocument()
    })

    it("renders the no-template placeholder when template is null", () => {
      render(<A2UITemplatePreview template={null} />)
      expect(screen.getByText("noTemplateSelected")).toBeInTheDocument()
    })

    it("renders the no-template placeholder when template is false", () => {
      render(<A2UITemplatePreview template={false} />)
      expect(screen.getByText("noTemplateSelected")).toBeInTheDocument()
    })

    it("does NOT render the card when template is absent", () => {
      render(<A2UITemplatePreview />)
      expect(screen.queryByTestId("card")).not.toBeInTheDocument()
    })
  })

  describe("with template", () => {
    const sampleTemplate = { type: "dashboard", rows: [{ cols: ["a", "b"] }] }

    it("renders the preview card when a template object is provided", () => {
      render(<A2UITemplatePreview template={sampleTemplate} />)
      expect(screen.getByTestId("card")).toBeInTheDocument()
    })

    it("shows the a2ui preview title translation key", () => {
      render(<A2UITemplatePreview template={sampleTemplate} />)
      expect(screen.getByText("a2uiTemplatePreviewTitle")).toBeInTheDocument()
    })

    it("renders JSON.stringify of the template inside a pre element", () => {
      render(<A2UITemplatePreview template={sampleTemplate} />)
      const pre = document.querySelector("pre")
      expect(pre).not.toBeNull()
      expect(pre!.textContent).toContain('"type": "dashboard"')
    })

    it("renders the scroll area around the JSON content", () => {
      render(<A2UITemplatePreview template={sampleTemplate} />)
      expect(screen.getByTestId("scroll-area")).toBeInTheDocument()
    })

    it("renders primitive string templates as JSON", () => {
      render(<A2UITemplatePreview template="hello" />)
      const pre = document.querySelector("pre")
      expect(pre!.textContent).toContain('"hello"')
    })

    it("renders numeric templates as JSON", () => {
      render(<A2UITemplatePreview template={42} />)
      const pre = document.querySelector("pre")
      expect(pre!.textContent).toContain("42")
    })

    it("renders array templates as JSON", () => {
      render(<A2UITemplatePreview template={[1, 2, 3]} />)
      const pre = document.querySelector("pre")
      expect(pre!.textContent).toContain("[")
      expect(pre!.textContent).toContain("1")
    })

    it("does NOT show the no-template placeholder when template is provided", () => {
      render(<A2UITemplatePreview template={sampleTemplate} />)
      expect(screen.queryByText("noTemplateSelected")).not.toBeInTheDocument()
    })
  })

  describe("ignored props", () => {
    it("accepts showPreview, onTogglePreview, className without crashing", () => {
      const toggle = jest.fn()
      expect(() =>
        render(
          <A2UITemplatePreview
            template={{ x: 1 }}
            showPreview
            onTogglePreview={toggle}
            className="extra"
          />
        )
      ).not.toThrow()
    })
  })
})
