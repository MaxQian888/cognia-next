/**
 * @jest-environment node
 */
// Build/process integration checks live separately so renderer unit tests do
// not spawn esbuild or a second Node process. Both reuse the existing fixtures.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

describe("MarkdownRenderer integration", () => {
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
      media: Array<{
        finalized: { invalidParagraphDescendants: number; figures: number; mediaParagraphs: number }
        streaming: { invalidParagraphDescendants: number; figures: number; mediaParagraphs: number }
      }>
      nativeImages: { paragraphs: number; mediaParagraphs: number }
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
    expect(result.media).toHaveLength(8)
    for (const entry of result.media) {
      expect(entry.finalized.invalidParagraphDescendants).toBe(0)
      expect(entry.streaming.invalidParagraphDescendants).toBe(0)
      expect(entry.finalized.mediaParagraphs).toBeGreaterThan(0)
      expect(entry.streaming.mediaParagraphs).toBeGreaterThan(0)
    }
    expect(result.media[0].finalized.figures).toBe(1)
    expect(result.media[0].streaming.figures).toBe(1)
    expect(result.nativeImages).toEqual({ paragraphs: 2, mediaParagraphs: 0 })
  })

  it("keeps real Markdown loading, success and error states valid through SSR and hydration", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cognia-markdown-states-"))
    const bundle = path.join(tempDir, "fixture.cjs")
    const leaves = path.join(tempDir, "leaves.tsx")
    // Keep the production parser, pre/code routing, loading callbacks and error
    // boundaries. Replace only chunk payloads and unrelated toolbar/link IO.
    writeFileSync(
      leaves,
      `
      import React from ${JSON.stringify(require.resolve("react"))}
      import { withMathErrorBoundary } from ${JSON.stringify(path.join(process.cwd(), "components/chat/renderers/math-error-boundary.tsx"))}
      export default function dynamic(loader, options) {
        const inline = loader.toString().includes("MathInline")
        const math = inline || loader.toString().includes("MathBlock")
        function Chunk({content}) {
          if (process.env.MARKDOWN_RENDER_STATE === "loading") return options.loading()
          if (process.env.MARKDOWN_RENDER_STATE === "error") throw new Error("fixture renderer failure")
          return React.createElement(inline ? "span" : "div", {"data-chunk": true}, content)
        }
        return math ? withMathErrorBoundary(Chunk, props => props.content, inline) : Chunk
      }
      export function CodeBlock({code}) { return <pre>{code}</pre> }
      export function ArtifactCreateButton() { return null }
      export function ChatLink({href,children}) { return <a href={href}>{children}</a> }
    `
    )
    let output = ""
    try {
      execFileSync(
        require.resolve("esbuild/bin/esbuild"),
        [
          "tests/integration/fixtures/markdown-renderer-states.tsx",
          "--bundle",
          "--platform=node",
          "--format=cjs",
          "--log-level=error",
          "--external:jest-environment-jsdom",
          ...[
            "math-inline",
            "math-block",
            "mermaid-block",
            "diff-block",
            "chart-block",
            "a2ui-block",
          ].map((name) => `--external:@/components/chat/renderers/${name}`),
          ...[
            "next/dynamic",
            "@/components/chat/renderers/code-block",
            "@/components/artifacts/artifact-create-button",
            "@/components/chat/markdown/chat-link",
          ].map((name) => `--alias:${name}=${leaves}`),
          "--outfile=" + bundle,
        ],
        { encoding: "utf8" }
      )
      output = execFileSync(process.execPath, [bundle], {
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, NODE_PATH: path.join(process.cwd(), "node_modules") },
      })
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
    const { results, failures } = JSON.parse(output.split("\nMARKDOWN_STATE_RESULT=").at(-1)!) as {
      results: Array<{
        state: string
        content: string
        inline: boolean
        invalidServerElements: number
        invalidClientElements: number
        hasParagraph: boolean
        hasBlock: boolean
        hasLoading: boolean
        hasError: boolean
      }>
      failures: string[]
    }
    expect(failures).toEqual([])
    expect(results).toHaveLength(93)
    for (const result of results) {
      expect(result).toMatchObject({ invalidServerElements: 0, invalidClientElements: 0 })
      expect(result.hasBlock).toBe(!result.inline)
      if (result.inline) expect(result.hasParagraph).toBe(true)
    }
    for (const state of ["loading", "success", "error"]) {
      const mermaid = results.find(
        (result) => result.state === state && result.content.startsWith("```mermaid")
      )!
      expect(mermaid.hasLoading).toBe(state === "loading")
      expect(mermaid.hasError).toBe(state === "error")
      const math = results.find(
        (result) => result.state === state && result.content === "Before $x^2$ after"
      )!
      expect(math.hasLoading).toBe(state === "loading")
      expect(math.hasError).toBe(state === "error")
    }
  }, 30000)
})
