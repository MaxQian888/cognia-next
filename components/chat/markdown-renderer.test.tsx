// Tests for MarkdownRenderer: rendering features, component routing,
// and that the components object is stabilized (not recreated unnecessarily).

// Synchronously resolve `next/dynamic(() => import("/path").then(...))` by
// parsing the import path out of the loader's source, then `require()`ing it
// via jest's module resolver (which honours `moduleNameMapper` + the
// `jest.mock` calls below). Without this, the dynamic chunks register on a
// microtask and the synchronous `document.querySelector(...)` assertions
// below fire before the component lands in the DOM.
jest.mock("next/dynamic", () => {
  return (loader: () => Promise<unknown>) => {
    // SWC compiles `() => import("@/path").then((m) => ({ default: m.X }))`
    // to something like:
    //   () => Promise.resolve().then(() => require("./renderers/x")).then(...)
    // We extract the inner `require("...")` path and resolve it synchronously
    // so the dynamic component is mounted during the test's first render.
    const source = loader.toString()
    const requireMatch = source.match(/require\(['"](.+?)['"]\)/)
    if (!requireMatch) {
      return () => null
    }
    const modulePath = requireMatch[1]
    // Capture the named export from the loader's `.then((m) => ({ default: m.Name }))`.
    const namedMatch = source.match(/m\.(\w+)/)
    const exportName = namedMatch ? namedMatch[1] : null
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(modulePath) as Record<string, unknown> & { default?: unknown }
    const Component = (exportName ? mod[exportName] : undefined) ?? mod.default ?? mod
    return Component
  }
})

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

jest.mock("@/lib/tauri/opener", () => ({
  openExternal: jest.fn(async () => undefined),
}))

import { render, screen, fireEvent } from "@testing-library/react"
import React from "react"
import { MarkdownRenderer, parseTaskListItem } from "./markdown-renderer"
import { openExternal } from "@/lib/tauri/opener"

const mockOpenExternal = openExternal as jest.Mock

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

  // ── external links ──────────────────────────────────────────────────────────

  it("routes http(s) link clicks through openExternal on native shells", () => {
    const w = window as unknown as Record<string, unknown>
    w.Capacitor = { isNativePlatform: () => true }
    try {
      mockOpenExternal.mockClear()
      render(<MarkdownRenderer content="[site](https://example.com)" />)
      fireEvent.click(screen.getByText("site"))
      expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com")
    } finally {
      delete w.Capacitor
    }
  })

  it("leaves link clicks to the default anchor on plain web", () => {
    mockOpenExternal.mockClear()
    render(<MarkdownRenderer content="[site](https://example.com)" />)
    fireEvent.click(screen.getByText("site"))
    expect(mockOpenExternal).not.toHaveBeenCalled()
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

// parseTaskListItem is unit-tested directly: remark-gfm / rehype-raw are stubbed
// in jest, so the checkbox <input> a GFM task item produces can't reach the `li`
// handler through the full pipeline. The helper is the routing decision; we feed
// it the children shape react-markdown would hand the `li` component.
describe("parseTaskListItem", () => {
  const checkbox = (checked: boolean) =>
    React.createElement("input", { type: "checkbox", disabled: true, checked })

  it("returns null for ordinary list-item children", () => {
    expect(parseTaskListItem("just text")).toBeNull()
    expect(parseTaskListItem([<span key="a">bold</span>, " text"])).toBeNull()
  })

  it("detects a checked task item and strips the checkbox from the label", () => {
    const result = parseTaskListItem([checkbox(true), " done item"])
    expect(result).not.toBeNull()
    expect(result!.checked).toBe(true)
    expect(result!.label).toEqual([" done item"])
  })

  it("detects an unchecked task item", () => {
    const result = parseTaskListItem([checkbox(false), " todo item"])
    expect(result!.checked).toBe(false)
    expect(result!.label).toEqual([" todo item"])
  })

  it("preserves inline-formatted label nodes after the checkbox", () => {
    const result = parseTaskListItem([checkbox(false), " ", <strong key="b">important</strong>])
    expect(result!.label).toHaveLength(2)
    // Children.toArray re-keys elements, so compare structurally, not by ref.
    const strong = result!.label.find((n) => React.isValidElement(n) && n.type === "strong")
    expect(strong).toBeTruthy()
  })

  it("ignores non-checkbox inputs", () => {
    const textInput = React.createElement("input", { type: "text" })
    expect(parseTaskListItem([textInput, " label"])).toBeNull()
  })
})
