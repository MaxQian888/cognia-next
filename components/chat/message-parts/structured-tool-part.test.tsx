/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { StructuredToolPart } from "./structured-tool-part"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Keep the expansion cheap: body routing is ToolDetailBody's own suite's job;
// here we only need to see whether the row mounted it.
jest.mock("@/components/chat/message-parts/tool-detail-body", () => ({
  ToolDetailBody: ({ part }: { part: { type: string } }) =>
    ReactForMocks.createElement("div", { "data-testid": "tool-detail-body" }, part.type),
}))
jest.mock("@/components/ai-elements/shimmer", () => ({
  Shimmer: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    ReactForMocks.createElement("span", { className, "data-testid": "shimmer" }, children),
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  ReadingCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? ReactForMocks.createElement("div", null, children) : null,
}))
jest.mock("@/components/chat/message-parts/tool-semantic-badges", () => ({
  ToolSemanticBadges: () => ReactForMocks.createElement("span", { "data-testid": "badges" }),
}))
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, copy: jest.fn(async () => true) }),
}))

function part(
  type: string,
  overrides: Partial<ToolUIPart> & { errorText?: string } = {}
): ToolUIPart {
  return {
    type,
    toolCallId: "tc-1",
    state: "output-available",
    input: {},
    output: {},
    ...overrides,
  } as unknown as ToolUIPart
}

describe("StructuredToolPart", () => {
  it("renders WebFetch as a compact row with url target and HTTP meta", () => {
    render(
      <StructuredToolPart
        part={part("tool-WebFetch", {
          input: { url: "https://example.com/a" },
          output: JSON.stringify({ status: 200, title: "Page" }),
        })}
      />
    )
    const row = screen.getByTestId("structured-tool-part")
    expect(row.getAttribute("data-kind")).toBe("webfetch")
    expect(row.textContent).toContain("verb.fetch")
    expect(row.textContent).toContain("https://example.com/a")
    expect(screen.getByTestId("structured-tool-meta").textContent).toContain(
      'chat.toolRow.meta.httpStatus:{"status":200}'
    )
    // Settled calls start collapsed — the body mounts only on expand.
    expect(screen.queryByTestId("tool-detail-body")).toBeNull()
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByTestId("tool-detail-body")).toBeInTheDocument()
  })

  it("folds the mcp__ namespace before looking the tool spec up", () => {
    render(
      <StructuredToolPart
        part={part("tool-mcp__cognia-tools__wiki_search", {
          input: { query: "adr" },
          output: JSON.stringify({ hits: [{}, {}] }),
        })}
      />
    )
    const row = screen.getByTestId("structured-tool-part")
    expect(row.getAttribute("data-kind")).toBe("wiki_search")
    expect(row.textContent).toContain("verb.wiki")
    expect(row.textContent).toContain("adr")
    expect(screen.getByTestId("structured-tool-meta").textContent).toContain(
      'chat.agentFlow.result.matches:{"count":2}'
    )
  })

  it("shimmers the target while the call is running and starts expanded", () => {
    render(
      <StructuredToolPart
        part={part("tool-WebSearch", {
          state: "input-available",
          input: { query: "cognia" },
        })}
      />
    )
    expect(screen.getByTestId("shimmer")).toHaveTextContent("cognia")
    expect(screen.getByTestId("structured-tool-meta")).toHaveTextContent("status.running")
    expect(screen.getByTestId("tool-detail-body")).toBeInTheDocument()
  })

  it("shows the error preview in destructive styling", () => {
    render(
      <StructuredToolPart
        part={part("tool-WebFetch", {
          state: "output-error",
          input: { url: "https://x.test" },
          errorText: "boom",
        } as Partial<ToolUIPart> & { errorText: string })}
      />
    )
    const meta = screen.getByTestId("structured-tool-meta")
    expect(meta.className).toContain("text-destructive")
    expect(meta.textContent).toContain("boom")
  })

  it("falls back to the humanized tool name for unknown tools", () => {
    render(
      <StructuredToolPart
        part={part("tool-mcp__plugin__frobnicate_thing", {
          output: JSON.stringify({ ok: true }),
        })}
      />
    )
    const row = screen.getByTestId("structured-tool-part")
    expect(row.getAttribute("data-kind")).toBe("frobnicate_thing")
    expect(row.textContent).toContain("Frobnicate thing")
  })

  it("prefers the provider-supplied title over the spec verb", () => {
    render(
      <StructuredToolPart
        part={part("tool-mcp__srv__custom", {
          title: "Provided Label",
          output: JSON.stringify({ ok: true }),
        } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.getByTestId("structured-tool-part").textContent).toContain("Provided Label")
  })
})

it("honors controlled disclosure and keeps its row mounted", () => {
  const onToggle = jest.fn()
  const tool = part("tool-Unknown")
  const { getByTestId, rerender } = render(
    <StructuredToolPart part={tool} expanded={false} onToggle={onToggle} />
  )
  const toggle = getByTestId("structured-tool-part-toggle")
  fireEvent.click(toggle)
  expect(onToggle).toHaveBeenCalledTimes(1)
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  rerender(<StructuredToolPart part={tool} expanded onToggle={onToggle} />)
  expect(getByTestId("structured-tool-part-toggle")).toBe(toggle)
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
})
