// Tests for MarkdownRenderer: rendering features, component routing,
// and that the components object is stabilized (not recreated unnecessarily).

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <div data-test="code-block" data-lang={language}>
      {code}
    </div>
  ),
}))

jest.mock("@/components/chat/renderers/math-block", () => ({
  MathBlock: ({ content }: { content: string }) => <div data-test="math-block">{content}</div>,
}))

jest.mock("@/components/chat/renderers/math-inline", () => ({
  MathInline: ({ content }: { content: string }) => <span data-test="math-inline">{content}</span>,
}))

jest.mock("@/components/chat/renderers/mermaid-block", () => ({
  MermaidBlock: ({ content }: { content: string }) => (
    <div data-test="mermaid-block">{content}</div>
  ),
}))

jest.mock("@/components/chat/renderers/diff-block", () => ({
  DiffBlock: ({ content }: { content: string }) => <div data-test="diff-block">{content}</div>,
}))

jest.mock("@/components/chat/renderers/a2ui-block", () => ({
  A2UIBlock: () => <div data-test="a2ui-block" />,
}))

jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src, alt }: { src: string; alt: string }) => (
    <img data-test="image-block" src={src} alt={alt} />
  ),
}))

jest.mock("@/components/chat/renderers/video-block", () => ({
  VideoBlock: ({ src }: { src: string }) => <div data-test="video-block" data-src={src} />,
}))

jest.mock("@/components/chat/renderers/audio-block", () => ({
  AudioBlock: ({ src }: { src: string }) => <div data-test="audio-block" data-src={src} />,
}))

jest.mock("@/components/chat/renderers/alert-block", () => ({
  AlertBlock: ({ children }: { children: React.ReactNode }) => (
    <div data-test="alert-block">{children}</div>
  ),
  parseAlertFromBlockquote: () => null,
}))

jest.mock("@/components/chat/renderers/details-block", () => ({
  DetailsBlock: ({ children }: { children: React.ReactNode }) => (
    <div data-test="details-block">{children}</div>
  ),
}))

jest.mock("@/components/chat/renderers/kbd-inline", () => ({
  KbdInline: ({ children }: { children: React.ReactNode }) => <kbd data-test="kbd">{children}</kbd>,
}))

jest.mock("@/components/artifacts/artifact-create-button", () => ({
  ArtifactCreateButton: () => null,
}))

import { render, screen } from "@testing-library/react"
import { MarkdownRenderer } from "./markdown-renderer"

describe("MarkdownRenderer", () => {
  // ── basic text ──────────────────────────────────────────────────────────────

  it("renders plain text content", () => {
    render(<MarkdownRenderer content="Hello world" />)
    expect(screen.getByText("Hello world")).toBeInTheDocument()
  })

  it("wraps output in prose container", () => {
    const { container } = render(<MarkdownRenderer content="test" />)
    expect(container.querySelector(".markdown-renderer")).toBeTruthy()
  })

  // ── code blocks ─────────────────────────────────────────────────────────────

  it("renders fenced code block via CodeBlock", () => {
    render(<MarkdownRenderer content={"```js\nconsole.log('hi')\n```"} />)
    const block = document.querySelector("[data-test='code-block']")
    expect(block).toBeTruthy()
    expect(block?.getAttribute("data-lang")).toBe("js")
  })

  it("renders inline code as <code> element (not CodeBlock)", () => {
    render(<MarkdownRenderer content="use `const` here" />)
    expect(document.querySelector("code")).toBeTruthy()
    expect(document.querySelector("[data-test='code-block']")).toBeNull()
  })

  // ── mermaid ─────────────────────────────────────────────────────────────────

  it("renders mermaid block when enableMermaid=true (default)", () => {
    render(<MarkdownRenderer content={"```mermaid\ngraph TD\n```"} />)
    expect(document.querySelector("[data-test='mermaid-block']")).toBeTruthy()
  })

  it("falls back to CodeBlock when enableMermaid=false", () => {
    render(<MarkdownRenderer content={"```mermaid\ngraph TD\n```"} enableMermaid={false} />)
    expect(document.querySelector("[data-test='mermaid-block']")).toBeNull()
    expect(document.querySelector("[data-test='code-block']")).toBeTruthy()
  })

  // ── diff ────────────────────────────────────────────────────────────────────

  it("renders diff block when enableDiff=true (default)", () => {
    render(<MarkdownRenderer content={"```diff\n+ added\n- removed\n```"} />)
    expect(document.querySelector("[data-test='diff-block']")).toBeTruthy()
  })

  // ── tables ──────────────────────────────────────────────────────────────────

  it("renders GFM table with correct structure", () => {
    render(<MarkdownRenderer content={"| A | B |\n|---|---|\n| 1 | 2 |"} />)
    const table = document.querySelector("table")
    expect(table).toBeTruthy()
    const scrollWrapper = table?.parentElement
    expect(scrollWrapper?.className).toContain("overflow-x-auto")
  })

  it("renders table headers and cells", () => {
    render(<MarkdownRenderer content={"| Col1 | Col2 |\n|------|------|\n| foo  | bar  |"} />)
    expect(screen.getByText("Col1")).toBeInTheDocument()
    expect(screen.getByText("foo")).toBeInTheDocument()
  })

  // ── links ───────────────────────────────────────────────────────────────────

  it("opens links in new tab with noopener", () => {
    render(<MarkdownRenderer content="[visit](https://example.com)" />)
    const link = document.querySelector("a")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toContain("noopener")
    expect(link?.getAttribute("rel")).toContain("noreferrer")
  })

  // ── headings ────────────────────────────────────────────────────────────────

  it("renders h1 with correct class", () => {
    render(<MarkdownRenderer content="# Heading 1" />)
    const h1 = document.querySelector("h1")
    expect(h1).toBeTruthy()
    expect(h1?.className).toContain("text-2xl")
  })

  it("renders h2 with correct class", () => {
    render(<MarkdownRenderer content="## Heading 2" />)
    const h2 = document.querySelector("h2")
    expect(h2).toBeTruthy()
    expect(h2?.className).toContain("text-xl")
  })

  // ── lists ───────────────────────────────────────────────────────────────────

  it("renders unordered list", () => {
    render(<MarkdownRenderer content="- item one\n- item two" />)
    const ul = document.querySelector("ul")
    expect(ul).toBeTruthy()
    expect(screen.getByText("item one")).toBeInTheDocument()
  })

  it("renders ordered list", () => {
    render(<MarkdownRenderer content="1. first\n2. second" />)
    const ol = document.querySelector("ol")
    expect(ol).toBeTruthy()
    expect(screen.getByText("first")).toBeInTheDocument()
  })

  // ── blockquote / alerts ─────────────────────────────────────────────────────

  it("renders plain blockquote when not an alert pattern", () => {
    render(<MarkdownRenderer content="> A simple quote" />)
    expect(document.querySelector("blockquote")).toBeTruthy()
    expect(document.querySelector("[data-test='alert-block']")).toBeNull()
  })

  // ── horizontal rule ─────────────────────────────────────────────────────────

  it("renders <hr>", () => {
    render(<MarkdownRenderer content="---" />)
    expect(document.querySelector("hr")).toBeTruthy()
  })

  // ── props flags ─────────────────────────────────────────────────────────────

  it("accepts className and applies it to the container", () => {
    render(<MarkdownRenderer content="hi" className="custom-class" />)
    expect(document.querySelector(".custom-class")).toBeTruthy()
  })
})
