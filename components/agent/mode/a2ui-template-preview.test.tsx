/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { A2UITemplatePreview } from "./a2ui-template-preview"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// The mocks forward every prop: the component tags Card / CardContent with its
// own test ids, and a mock that only passed `children` + `className` would drop
// them silently.
jest.mock("@/components/ui/card", () => ({
  Card: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div data-testid="card" {...rest}>
      {children}
    </div>
  ),
  CardContent: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div data-testid="card-content" {...rest}>
      {children}
    </div>
  ),
  CardHeader: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div data-testid="card-header" {...rest}>
      {children}
    </div>
  ),
  CardTitle: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div data-testid="card-title" {...rest}>
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div data-testid="scroll-area" {...rest}>
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
      expect(screen.queryByTestId("a2ui-template-preview")).not.toBeInTheDocument()
    })
  })

  describe("with template", () => {
    const sampleTemplate = { type: "dashboard", rows: [{ cols: ["a", "b"] }] }

    it("renders the preview card when a template object is provided", () => {
      render(<A2UITemplatePreview template={sampleTemplate} />)
      expect(screen.getByTestId("a2ui-template-preview")).toBeInTheDocument()
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

  // These three props were declared and then ignored for long enough that the
  // custom-mode editor's own test grew a mock with a toggle button the real
  // component never had. They are load-bearing now.
  describe("collapsible body", () => {
    const tree = {
      name: "Status board",
      description: "one card",
      components: [
        { component: "Card", children: [{ component: "Text" }, { component: "Button" }] },
      ],
    }

    it("hides the body when the caller says the preview is off", () => {
      render(
        <A2UITemplatePreview template={tree} showPreview={false} onTogglePreview={jest.fn()} />
      )
      expect(screen.queryByTestId("a2ui-template-body")).not.toBeInTheDocument()
      expect(document.querySelector("pre")).toBeNull()
    })

    it("calls back when the toggle is used", () => {
      const toggle = jest.fn()
      render(<A2UITemplatePreview template={tree} showPreview onTogglePreview={toggle} />)
      fireEvent.click(screen.getByTestId("a2ui-toggle-preview"))
      expect(toggle).toHaveBeenCalledTimes(1)
    })

    it("stays expanded with no toggle handler rather than rendering a header over nothing", () => {
      render(<A2UITemplatePreview template={tree} showPreview={false} />)
      expect(screen.getByTestId("a2ui-template-body")).toBeInTheDocument()
      expect(screen.queryByTestId("a2ui-toggle-preview")).not.toBeInTheDocument()
    })

    it("applies the caller's className to the card and to the empty state", () => {
      const { unmount } = render(<A2UITemplatePreview template={tree} className="extra" />)
      expect(screen.getByTestId("a2ui-template-preview").className).toContain("extra")
      unmount()
      render(<A2UITemplatePreview className="extra" />)
      expect(screen.getByTestId("a2ui-template-empty").className).toContain("extra")
    })
  })

  describe("structure read-out", () => {
    it("counts the template's top-level components", () => {
      render(
        <A2UITemplatePreview
          template={{ components: [{ component: "Card" }, { component: "Text" }] }}
        />
      )
      expect(screen.getByTestId("a2ui-template-count").textContent).toContain('"n":2')
    })

    it("flattens the component tree with its nesting depth", () => {
      render(
        <A2UITemplatePreview
          template={{ components: [{ component: "Card", children: [{ component: "Text" }] }] }}
        />
      )
      const rows = screen.getByTestId("a2ui-template-tree").querySelectorAll("li")
      expect([...rows].map((r) => r.textContent)).toEqual(["Card", "Text"])
    })

    it("survives a template whose components are not an array", () => {
      render(<A2UITemplatePreview template={{ components: "nope" }} />)
      expect(screen.getByTestId("a2ui-template-count").textContent).toContain('"n":0')
      expect(screen.queryByTestId("a2ui-template-tree")).not.toBeInTheDocument()
    })

    it("does not loop on a self-referencing tree", () => {
      const node: Record<string, unknown> = { component: "Card" }
      node.children = [node]
      render(<A2UITemplatePreview template={{ name: "cyclic", components: [node] }} />)
      expect(screen.getByTestId("a2ui-template-tree").querySelectorAll("li")).toHaveLength(1)
    })
  })
})
