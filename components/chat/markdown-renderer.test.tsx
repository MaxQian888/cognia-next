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
  parseAlertFromBlockquote: (content: string) =>
    content.startsWith("[!WARNING]")
      ? { type: "warning", content: content.replace("[!WARNING]", "").trim() }
      : null,
}))

jest.mock("@/components/chat/renderers/details-block", () => ({
  DetailsBlock: ({ children }: { children: React.ReactNode }) => (
    <div data-test="details-block">{children}</div>
  ),
}))

jest.mock("@/components/chat/renderers/kbd-inline", () => ({
  KbdInline: ({ children }: { children: React.ReactNode }) => <kbd data-test="kbd">{children}</kbd>,
}))

jest.mock("@/components/chat/renderers/task-list", () => ({
  TaskListItem: ({ checked, children }: { checked: boolean; children: React.ReactNode }) => (
    <li data-test="task-list-item" data-checked={String(checked)}>
      {children}
    </li>
  ),
}))

jest.mock("@/components/artifacts/artifact-create-button", () => ({
  ArtifactCreateButton: () => null,
}))

jest.mock("@/lib/tauri/opener", () => ({
  openExternal: jest.fn(async () => undefined),
}))

import { render, screen, fireEvent } from "@testing-library/react"
import React from "react"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { MarkdownRenderer, addMarkdownHeadingIds, parseTaskListItem } from "./markdown-renderer"
import { openExternal } from "@/lib/tauri/opener"

const mockOpenExternal = openExternal as jest.Mock

describe("MarkdownRenderer", () => {
  // ── basic text ──────────────────────────────────────────────────────────────

  it("renders plain text content", () => {
    render(<MarkdownRenderer content="Hello world" />)
    expect(screen.getByText("Hello world")).toBeInTheDocument()
  })

  it("wraps output in a typeset chat container", () => {
    const { container } = render(<MarkdownRenderer content="test" />)
    const root = container.querySelector(".markdown-renderer")
    expect(root).toBeTruthy()
    // Without both classes every block element inside renders unstyled: the
    // per-element utilities were removed when typeset took over the rhythm.
    expect(root).toHaveClass("typeset", "typeset-chat")
  })

  it("drops the chat preset for a document surface", () => {
    // `typeset-chat` tightens leading and flow because "a turn is a
    // conversation, not an article" (app/typeset.css). Plugin READMEs and
    // skill docs are articles — they used to carry Tailwind `prose` for this —
    // so they read typeset's own document rhythm instead.
    const { container } = render(<MarkdownRenderer content="test" rhythm="document" />)
    const root = container.querySelector(".markdown-renderer")
    expect(root).toHaveClass("typeset")
    expect(root).not.toHaveClass("typeset-chat")
  })

  it("keeps shared semantics and URL policy in parity with real Streamdown", () => {
    const fixture = path.join(
      process.cwd(),
      "tests/integration/fixtures/markdown-renderer-parity.tsx"
    )
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cognia-markdown-parity-"))
    const bundle = path.join(tempDir, "fixture.cjs")
    let output = ""
    try {
      execFileSync(
        require.resolve("esbuild/bin/esbuild"),
        [
          fixture,
          "--bundle",
          "--platform=node",
          "--format=cjs",
          "--log-level=error",
          "--outfile=" + bundle,
        ],
        { encoding: "utf8" }
      )
      output = execFileSync(process.execPath, [bundle], { encoding: "utf8" })
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
    const result = JSON.parse(output) as {
      finalized: Record<string, unknown>
      streaming: Record<string, unknown>
    }

    expect(result.finalized).toEqual(result.streaming)
    expect(result.finalized).toMatchObject({
      orderedListStart: "4",
      tableAlignment: ["left", "center", "right"],
      details: true,
      keyboard: "Cmd",
      tel: 1,
      file: 1,
      unsafe: 0,
      dataImage: 1,
    })
  })

  // typeset's element rules are an unbounded descendant match, so any block
  // painting its own `pre`/`table` has to opt out at its mount — see the
  // comment on the `code` override.
  it.each([
    ["```js\nconst a = 1\n```", "code-block"],
    ["```mermaid\ngraph TD;\n```", "mermaid-block"],
    ["```diff\n- a\n+ b\n```", "diff-block"],
    ["$$x^2$$", "math-block"],
  ])("isolates %# from typeset so it keeps painting itself", (content, testMarker) => {
    render(<MarkdownRenderer content={content} />)
    const block = document.querySelector(`[data-test="${testMarker}"]`)
    expect(block).toBeTruthy()
    expect(block?.closest(".not-typeset")).toBeTruthy()
  })

  it("lets inline code take its size from the surrounding typeset preset", () => {
    render(<MarkdownRenderer content="use `npm run dev` here" />)
    const code = screen.getByText("npm run dev")
    expect(code.tagName).toBe("CODE")
    expect(code).toHaveClass("bg-muted", "font-mono")
    // A pinned `text-sm` would render 14px inline code in a compact tool card
    // and a full-width README alike.
    expect(code.className).not.toMatch(/\btext-(xs|sm|base|lg)\b/)
  })

  it("orders CJK parsing around GFM and adds math only when enabled", () => {
    const { rerender } = render(<MarkdownRenderer content="中文**强调**。" />)
    const withMath = screen.getByTestId("react-markdown-config").dataset.remarkOrder?.split(",")
    expect(withMath).toHaveLength(4)
    expect(withMath?.[0]).toBe("cjkBefore")
    expect(withMath?.[2]).toBe("cjkAfter")

    rerender(<MarkdownRenderer content="中文**强调**。" enableMath={false} />)
    const withoutMath = screen.getByTestId("react-markdown-config").dataset.remarkOrder?.split(",")
    expect(withoutMath).toHaveLength(3)
    expect(withoutMath?.[0]).toBe("cjkBefore")
    expect(withoutMath?.[2]).toBe("cjkAfter")
  })

  it("normalizes both LaTeX delimiter styles only when math is enabled", () => {
    const { rerender } = render(<MarkdownRenderer content={"\\(x^2\\) and \\[y^2\\]"} />)
    expect(screen.getByText("$x^2$ and $$y^2$$")).toBeInTheDocument()

    rerender(<MarkdownRenderer content={"\\(x^2\\) and \\[y^2\\]"} enableMath={false} />)
    expect(screen.getByText("\\(x^2\\) and \\[y^2\\]")).toBeInTheDocument()
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

  it("routes workspace file links through the owning conversation", () => {
    const onOpenProjectFile = jest.fn()
    render(
      <MarkdownRenderer
        content="[app](src/app.ts#L7C2)"
        projectRoot="/repo"
        onOpenProjectFile={onOpenProjectFile}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "app" }))

    expect(onOpenProjectFile).toHaveBeenCalledWith({
      absolutePath: "/repo/src/app.ts",
      line: 7,
      column: 2,
    })
  })

  it("preserves file URLs through sanitization and routes them as project files", () => {
    const onOpenProjectFile = jest.fn()
    render(
      <MarkdownRenderer
        content="[app](file:///repo/src/app.ts#L5C3)"
        projectRoot="/repo"
        onOpenProjectFile={onOpenProjectFile}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "app" }))
    expect(onOpenProjectFile).toHaveBeenCalledWith({
      absolutePath: "/repo/src/app.ts",
      line: 5,
      column: 3,
    })
  })

  // ── code blocks ─────────────────────────────────────────────────────────────

  it("renders fenced code block via CodeBlock", () => {
    render(<MarkdownRenderer content={"```js\nconsole.log('hi')\n```"} />)
    const block = document.querySelector("[data-test='code-block']")
    expect(block).toBeTruthy()
    expect(block?.getAttribute("data-lang")).toBe("js")
  })

  it("renders a one-line unlabelled fence as a block instead of inline code", () => {
    render(<MarkdownRenderer content={"```\nplain text\n```"} />)
    expect(document.querySelector("[data-test='code-block']")).toHaveTextContent("plain text")
    expect(document.querySelector("p > code")).toBeNull()
  })

  it("preserves punctuation in fenced-code language identifiers", () => {
    render(<MarkdownRenderer content={"```c++\nint main() {}\n```"} />)
    expect(document.querySelector("[data-test='code-block']")).toHaveAttribute("data-lang", "c++")
  })

  it("renders inline code as <code> element (not CodeBlock)", () => {
    render(<MarkdownRenderer content="use `const` here" />)
    expect(document.querySelector("code")).toBeTruthy()
    expect(document.querySelector("[data-test='code-block']")).toBeNull()
  })

  it("makes an inline project file reference navigable", () => {
    const onOpenProjectFile = jest.fn()
    render(
      <MarkdownRenderer
        content="see `src/app.ts:9:2`"
        projectRoot="/repo"
        onOpenProjectFile={onOpenProjectFile}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "src/app.ts:9:2" }))
    expect(onOpenProjectFile).toHaveBeenCalledWith({
      absolutePath: "/repo/src/app.ts",
      line: 9,
      column: 2,
    })
  })

  // ── math ──────────────────────────────────────────────────────────────────

  it("routes inline and display math through their dedicated renderers", () => {
    const { rerender } = render(<MarkdownRenderer content="$x^2$" />)
    expect(document.querySelector("[data-test='math-inline']")).toHaveTextContent("x^2")

    rerender(<MarkdownRenderer content="$$y^2$$" />)
    expect(document.querySelector("[data-test='math-block']")).toHaveTextContent("y^2")
  })

  it("falls back to a code block when math rendering is disabled", () => {
    render(<MarkdownRenderer content={"```math\nx^2\n```"} enableMath={false} />)
    expect(document.querySelector("[data-test='math-inline']")).toBeNull()
    expect(document.querySelector("[data-test='code-block']")).toHaveTextContent("x^2")
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

  it("renders A2UI fences through the dedicated renderer", () => {
    render(<MarkdownRenderer content={'```a2ui\n{"type":"Text"}\n```'} />)
    expect(document.querySelector("[data-test='a2ui-block']")).toBeTruthy()
  })

  // ── media ─────────────────────────────────────────────────────────────────

  it("renders images through the enhanced image renderer", () => {
    render(<MarkdownRenderer content="![diagram](https://cdn.example.com/diagram.png)" />)
    expect(document.querySelector("[data-test='image-block']")).toHaveAttribute(
      "src",
      "https://cdn.example.com/diagram.png"
    )
  })

  it("falls back to a lazy native image when enhanced images are disabled", () => {
    render(
      <MarkdownRenderer
        content="![diagram](https://cdn.example.com/diagram.png)"
        enableEnhancedImages={false}
      />
    )
    expect(document.querySelector("[data-test='image-block']")).toBeNull()
    expect(document.querySelector("img")).toHaveAttribute("loading", "lazy")
  })

  it("falls back to enhanced images when media embeds are disabled", () => {
    const { rerender } = render(
      <MarkdownRenderer
        content="![video](https://cdn.example.com/demo.mp4)"
        enableVideoEmbed={false}
      />
    )
    expect(document.querySelector("[data-test='video-block']")).toBeNull()
    expect(document.querySelector("[data-test='image-block']")).toBeTruthy()

    rerender(
      <MarkdownRenderer
        content="![audio](https://cdn.example.com/demo.mp3)"
        enableAudioEmbed={false}
      />
    )
    expect(document.querySelector("[data-test='audio-block']")).toBeNull()
    expect(document.querySelector("[data-test='image-block']")).toBeTruthy()
  })

  it("recognizes video URLs with query strings", () => {
    render(<MarkdownRenderer content="![demo](https://cdn.example.com/demo.mp4?token=abc)" />)
    expect(document.querySelector("[data-test='video-block']")).toHaveAttribute(
      "data-src",
      "https://cdn.example.com/demo.mp4?token=abc"
    )
  })

  it("recognizes audio URLs with fragments", () => {
    render(<MarkdownRenderer content="![sample](https://cdn.example.com/sample.flac#t=10)" />)
    expect(document.querySelector("[data-test='audio-block']")).toHaveAttribute(
      "data-src",
      "https://cdn.example.com/sample.flac#t=10"
    )
  })

  it("routes Ogg audio and Ogg video to their unambiguous renderers", () => {
    const { rerender } = render(
      <MarkdownRenderer content="![audio](https://cdn.example.com/sample.ogg)" />
    )
    expect(document.querySelector("[data-test='audio-block']")).toBeTruthy()
    expect(document.querySelector("[data-test='video-block']")).toBeNull()

    rerender(<MarkdownRenderer content="![video](https://cdn.example.com/sample.ogv)" />)
    expect(document.querySelector("[data-test='video-block']")).toBeTruthy()
  })

  it("recognizes supported video hosts without accepting lookalike domains", () => {
    const { rerender } = render(
      <MarkdownRenderer content="![video](https://www.youtube.com/watch?v=abc)" />
    )
    expect(document.querySelector("[data-test='video-block']")).toBeTruthy()

    rerender(<MarkdownRenderer content="![image](https://youtube.com.evil.example/cover)" />)
    expect(document.querySelector("[data-test='video-block']")).toBeNull()
    expect(document.querySelector("[data-test='image-block']")).toBeTruthy()
  })

  it("treats a non-absolute video-host string as an ordinary image URL", () => {
    render(<MarkdownRenderer content="![image](youtube.com/watch?v=abc)" />)
    expect(document.querySelector("[data-test='video-block']")).toBeNull()
    expect(document.querySelector("[data-test='image-block']")).toHaveAttribute(
      "src",
      "youtube.com/watch?v=abc"
    )
  })

  // ── tables ──────────────────────────────────────────────────────────────────

  it("renders GFM table with correct structure", () => {
    render(<MarkdownRenderer content={"| A | B |\n|---|---|\n| 1 | 2 |"} />)
    const table = document.querySelector("table")
    expect(table).toBeTruthy()
    const scrollWrapper = table?.parentElement
    expect(scrollWrapper?.className).toContain("typeset-scroll")
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

  it("keeps fragment links in the current document", () => {
    render(<MarkdownRenderer content="[details](#details)" />)
    const link = screen.getByRole("link", { name: "details" })
    expect(link).not.toHaveAttribute("target")
    expect(link).not.toHaveAttribute("rel")
  })

  // ── headings ────────────────────────────────────────────────────────────────

  it("renders every heading level with an anchor offset and no size of its own", () => {
    render(
      <MarkdownRenderer
        content={"# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6"}
        enableMath={false}
      />
    )
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const heading = screen.getByRole("heading", { level })
      expect(heading).toHaveClass("scroll-mt-20")
      expect(heading.className).not.toMatch(/\btext-(xs|sm|base|lg|xl|\dxl)\b/)
    }
    expect(screen.getByRole("heading", { level: 6 })).toHaveClass("normal-case")
  })

  // ── safe raw HTML ─────────────────────────────────────────────────────────

  it("routes safe details and keyboard elements through dedicated renderers", () => {
    render(
      <MarkdownRenderer content={"<details><summary>More</summary>Body</details>\n<kbd>⌘K</kbd>"} />
    )
    expect(document.querySelector("[data-test='details-block']")).toHaveTextContent("Body")
    expect(document.querySelector("[data-test='kbd']")).toHaveTextContent("⌘K")
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

  it("renders GitHub alerts unless alert rendering is disabled", () => {
    const { rerender } = render(<MarkdownRenderer content="> [!WARNING] Careful" />)
    expect(document.querySelector("[data-test='alert-block']")).toHaveTextContent("Careful")

    rerender(<MarkdownRenderer content="> [!WARNING] Careful" enableAlerts={false} />)
    expect(document.querySelector("[data-test='alert-block']")).toBeNull()
    expect(document.querySelector("blockquote")).toBeTruthy()
  })

  it("routes GFM task-list items through the task renderer", () => {
    render(<MarkdownRenderer content="- [x] complete" />)
    expect(document.querySelector("[data-test='task-list-item']")).toHaveAttribute(
      "data-checked",
      "true"
    )
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

describe("addMarkdownHeadingIds", () => {
  it("adds stable slugs and disambiguates duplicate headings", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "Quick Start" }],
        },
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "Quick Start" }],
        },
        {
          type: "element",
          tagName: "h3",
          properties: {},
          children: [{ type: "text", value: "中文渲染" }],
        },
      ],
    }

    addMarkdownHeadingIds(tree)

    expect(tree.children[0].properties).toMatchObject({ id: "quick-start" })
    expect(tree.children[1].properties).toMatchObject({ id: "quick-start-1" })
    expect(tree.children[2].properties).toMatchObject({ id: "中文渲染" })
  })

  it("preserves an explicit heading id and ignores empty headings", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: { id: "custom" },
          children: [{ type: "text", value: "Custom" }],
        },
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "!!!" }],
        },
      ],
    }

    addMarkdownHeadingIds(tree)

    expect(tree.children[0].properties).toMatchObject({ id: "custom" })
    expect(tree.children[1].properties).toEqual({})
  })

  it("collects nested heading text and safely ignores non-tree input", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [
            { type: "text", value: "Rich " },
            {
              type: "element",
              tagName: "code",
              children: [{ type: "text", value: "Text" }],
            },
          ],
        },
      ],
    }

    addMarkdownHeadingIds(null)
    addMarkdownHeadingIds(tree)

    expect(tree.children[0].properties).toMatchObject({ id: "rich-text" })
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
