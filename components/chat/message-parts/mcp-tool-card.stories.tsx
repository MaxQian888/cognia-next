import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { MCPToolCard } from "./mcp-tool-card"

// MCPToolCard routes a tool part to its structured sub-renderer by tool name,
// falling back to the generic ToolBody for unknown tools. The file tools
// (Read/Grep/…) never reach it — `FileToolPart` owns those parts upstream —
// so the fallback stories below use unregistered tool names.
const jsonInOutPart: ToolUIPart = {
  type: "tool-deploy_preview",
  toolCallId: "call-json",
  state: "output-available",
  input: { url: "https://preview.acme.dev/42", wait: true },
  output: { ok: true, url: "https://preview.acme.dev/42", expires: "2026-09-24" },
} as unknown as ToolUIPart

const longInputPart: ToolUIPart = {
  type: "tool-create_issue",
  toolCallId: "call-long",
  state: "output-available",
  input: {
    repo: "acme/widgets",
    title: "Message stream overflows on narrow viewports",
    body: "When the chat pane is narrowed below ~360px, tool rows overflow horizontally instead of truncating. Steps to reproduce:\n\n1. Open any session with tool calls\n2. Drag the pane narrower\n3. Observe the row meta pushing past the edge",
    labels: ["bug", "ui", "chat"],
    milestone: 12,
    assignees: ["octocat", "devin"],
  },
  output: JSON.stringify({ issue: 847, url: "https://github.com/acme/widgets/issues/847" }),
} as unknown as ToolUIPart

const webSearchPart: ToolUIPart = {
  type: "tool-WebSearch",
  toolCallId: "call-ws",
  state: "output-available",
  input: { query: "Next.js 16 static export limitations" },
  output: JSON.stringify({
    provider: "tavily",
    answer:
      "Static export removes the Node server entirely — middleware, rewrites, and server actions are unavailable, and every route must produce a file under out/.",
    results: [
      {
        title: "Static Exports",
        url: "https://nextjs.org/docs/app/building-your-application/deploying/static-exports",
        favicon: "https://nextjs.org/favicon.ico",
        content:
          "Next.js enables starting as a static site or Single-Page Application (SPA), then later optionally upgrading…",
        publishedDate: "2026-08-14",
      },
      {
        title: "next.config.ts — output: 'export'",
        url: "https://github.com/vercel/next.js/discussions/54393",
        content:
          "Setting output to export disables features that need a server: rewrites, redirects, headers, middleware…",
        publishedDate: "2025-11-02",
      },
      {
        title: "Static export checklist — cognia.dev",
        url: "https://cognia.dev/docs/static-export",
        content:
          "A short checklist of what breaks when you flip output: 'export' in an App Router project.",
      },
      {
        title: "next export vs output: export — Stack Overflow",
        url: "https://stackoverflow.com/questions/76134624",
        favicon: "https://cdn.sstatic.net/Sites/stackoverflow/Img/favicon.ico",
        content: "The old next export command is deprecated in favour of the output config flag…",
        publishedDate: "2024-05-11",
      },
      {
        title: "Deploying static exports — Vercel docs",
        url: "https://vercel.com/docs/frameworks/nextjs#static-exports",
        content:
          "Static exports can be deployed to any static host, including Vercel, Pages, and S3…",
      },
      {
        title: "App Router static export pitfalls",
        url: "https://blog.logrocket.com/next-js-static-export",
        favicon: "https://blog.logrocket.com/favicon.ico",
        content: "Watch out for generateStaticParams on dynamic routes and cookies() calls…",
        publishedDate: "2025-03-22",
      },
      {
        title: "Static hosting comparison — cognia.dev",
        url: "https://cognia.dev/docs/static-hosting",
        content:
          "Where an out/ bundle can live: Cloudflare Pages, Vercel, Netlify, or a Tauri webview.",
      },
    ],
  }),
} as unknown as ToolUIPart

const webFetchPart: ToolUIPart = {
  type: "tool-WebFetch",
  toolCallId: "call-wf",
  state: "output-available",
  input: { url: "https://cognia.dev/docs/tool-rows", prompt: "summarise the limits" },
  output: {
    ok: true,
    status: 200,
    url: "https://cognia.dev/en/docs/tool-rows",
    title: "Tool rows — Cognia docs",
    contentType: "text/markdown",
    content:
      "Tool calls render as compact rows: a status dot, the verb, and a mono target. The expanded body carries only the payload — headers, prompts and results — never a second copy of the target.\n\nLong output is clamped behind a fade with an explicit show-all affordance.",
  },
} as unknown as ToolUIPart

const unknownPart: ToolUIPart = {
  type: "tool-SomeThirdPartyTool",
  toolCallId: "call-x",
  state: "output-available",
  input: { foo: "bar" },
  output: "plain string output",
} as unknown as ToolUIPart

const errorPart: ToolUIPart = {
  type: "tool-deploy_preview",
  toolCallId: "call-err",
  state: "output-error",
  input: { url: "https://preview.acme.dev/42" },
  errorText: "Error: request timed out after 30000ms\n    at deploy (acme.ts:41:13)",
} as unknown as ToolUIPart

const meta = {
  title: "Chat/MessageParts/MCPToolCard",
  component: MCPToolCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof MCPToolCard>

export default meta
type Story = StoryObj<typeof meta>

// `WebSearch` → structured WebSearchCard (registered built-in): quote-rail
// answer + favicon/domain result rows.
export const WebSearchTool: Story = {
  args: { part: webSearchPart },
}

// `WebFetch` → structured WebFetchCard: redirect notice, title+prompt line,
// and the railed prose body.
export const WebFetchTool: Story = {
  args: { part: webFetchPart },
}

// Unregistered tool → compact `input`/`output` fallback blocks.
export const GenericJsonFallback: Story = {
  args: { part: jsonInOutPart },
}

// Large input → the block scrolls instead of collapsing behind a toggle.
export const GenericLongInput: Story = {
  args: { part: longInputPart },
}

// Plain-string output → generic fallback with the resolved renderer.
export const UnknownToolFallback: Story = {
  args: { part: unknownPart },
}

// `output-error` → red-toned error block with the parsed trace.
export const ErrorFallback: Story = {
  args: { part: errorPart },
}
