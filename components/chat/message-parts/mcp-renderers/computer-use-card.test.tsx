import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import chatMessages from "@/i18n/messages/en/chat.json"
import { ComputerUseCard } from "./computer-use-card"

// ImageBlock (used for the frame path) leans on shadcn's TooltipIconButton,
// which requires a TooltipProvider in the React tree. App-level layout mounts
// one, so mirror that wrapper to render the way production does.
function renderCard(p: ToolUIPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ chat: chatMessages }}>
      <TooltipProvider>
        <ComputerUseCard part={p} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

function part(overrides: Partial<ToolUIPart> & { mcpContent?: unknown[] } = {}): ToolUIPart {
  return {
    type: "tool-get_app_state",
    toolCallId: "tc-1",
    state: "output-available",
    input: {},
    output: undefined,
    ...overrides,
  } as ToolUIPart
}

describe("ComputerUseCard", () => {
  it("renders the frame from the MCP image block", () => {
    // The screenshot travels as a real image block now, not base64 inside
    // `output`. Reading `output` was why this card rendered nothing.
    renderCard(
      part({
        mcpContent: [
          { type: "image", data: TINY_PNG_B64, mimeType: "image/png" },
          { type: "text", text: "{}" },
        ],
        output: JSON.stringify({
          app: { displayName: "Notes" },
          revision: 4,
          screenshot: { width: 1600, height: 1200 },
        }),
      })
    )
    expect(screen.getByTestId("computer-use-card-frame")).toBeInTheDocument()
    expect(screen.getByText(/Notes/)).toBeInTheDocument()
    expect(screen.getByText(/1600×1200/)).toBeInTheDocument()
  })

  it("shows the zoom region so the origin is visible", () => {
    // Without the origin the operator cannot tell where in the frame the crop
    // came from.
    renderCard(
      part({
        type: "tool-zoom",
        mcpContent: [{ type: "image", data: TINY_PNG_B64, mimeType: "image/png" }],
        output: JSON.stringify({
          revision: 2,
          screenshot: { width: 320, height: 240 },
          region: { x: 400, y: 300, width: 320, height: 240 },
        }),
      } as Partial<ToolUIPart>)
    )
    expect(screen.getByText(/region \(400, 300\) 320×240/)).toBeInTheDocument()
  })

  it("reports a withheld frame as unchanged rather than as a failure", () => {
    renderCard(
      part({
        output: JSON.stringify({
          revision: 9,
          screenshotUnchanged: true,
          screenshotNote: "No visible change since r8.",
        }),
      })
    )
    expect(screen.getByTestId("computer-use-card-unchanged")).toBeInTheDocument()
    expect(screen.getByText("No visible change since r8.")).toBeInTheDocument()
  })

  it("renders a perform_action result with its revision transition", () => {
    renderCard(
      part({
        type: "tool-perform_action",
        input: { request: { action: { kind: "click" }, target: { kind: "element" } } },
        output: JSON.stringify({
          status: "delivered",
          method: "ax",
          beforeRevision: 4,
          afterRevision: 5,
        }),
      } as Partial<ToolUIPart>)
    )
    expect(screen.getByTestId("computer-use-card-action")).toBeInTheDocument()
    expect(screen.getByText("delivered")).toBeInTheDocument()
    expect(screen.getByText("element")).toBeInTheDocument()
    expect(screen.getByText("r4 → r5")).toBeInTheDocument()
  })

  it("renders a refused action with its status", () => {
    renderCard(
      part({
        type: "tool-perform_action",
        input: { request: { action: { kind: "typeText" } } },
        output: JSON.stringify({ status: "refused", beforeRevision: 1 }),
      } as Partial<ToolUIPart>)
    )
    expect(screen.getByText("refused")).toBeInTheDocument()
  })

  it("summarises an OCR match count", () => {
    renderCard(
      part({
        type: "tool-find_text",
        input: { query: "Save" },
        output: JSON.stringify({ ok: true, matches: [{ text: "Save" }, { text: "Save As" }] }),
      } as Partial<ToolUIPart>)
    )
    expect(screen.getByTestId("computer-use-card-ocr")).toBeInTheDocument()
    expect(screen.getByText("2 matches")).toBeInTheDocument()
  })

  it("names what click_text actually clicked", () => {
    renderCard(
      part({
        type: "tool-click_text",
        input: { query: "Save" },
        output: JSON.stringify({ ok: true, clicked: { text: "Save As" } }),
      } as Partial<ToolUIPart>)
    )
    expect(screen.getByText("Save As")).toBeInTheDocument()
  })

  it("falls back to a node count for tree reads", () => {
    renderCard(
      part({
        type: "tool-query_elements",
        output: JSON.stringify({ tree: { nodes: [{}, {}, {}] } }),
      } as Partial<ToolUIPart>)
    )
    expect(screen.getByTestId("computer-use-card-generic")).toBeInTheDocument()
    expect(screen.getByText("3 nodes")).toBeInTheDocument()
  })

  it("resolves the namespaced MCP tool name to the bare one", () => {
    renderCard(
      part({
        type: "tool-mcp__cognia-plugin-tools__list_apps",
        output: JSON.stringify({}),
      } as Partial<ToolUIPart>)
    )
    expect(screen.getByText("list_apps")).toBeInTheDocument()
  })
})
