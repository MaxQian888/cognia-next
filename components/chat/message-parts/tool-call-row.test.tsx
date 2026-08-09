/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { fireEvent, render } from "@testing-library/react"

import { ToolCallRow } from "./tool-call-row"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Avoid pulling the heavy code-block / markdown stack into the row test.
jest.mock("@/components/ai-elements/tool", () => ({
  ToolBody: ({ part }: { part: { type: string } }) =>
    ReactForMocks.createElement("div", { "data-testid": "tool-body" }, part.type),
  ToolInput: ({ input }: { input: unknown }) =>
    ReactForMocks.createElement("div", { "data-testid": "tool-input" }, JSON.stringify(input)),
}))
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    ReactForMocks.createElement("pre", { "data-testid": "code-block" }, code),
}))
jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src }: { src: string }) =>
    ReactForMocks.createElement("img", { "data-testid": "image-block", src, alt: "" }),
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "md" }, content),
}))

function part(type: string, input?: unknown, state = "output-available") {
  return { type, input, state } as never
}

function partWith(
  type: string,
  extra: {
    input?: unknown
    output?: unknown
    errorText?: unknown
    state?: string
    title?: string
    toolMetadata?: unknown
  }
) {
  return { type, state: "output-available", ...extra } as never
}

describe("ToolCallRow", () => {
  it("renders the tool name + target + status, body hidden by default", () => {
    const { getByText, queryByTestId, getByTestId } = render(
      <ToolCallRow part={part("tool-Read", { file_path: "/a/b/file.ts" })} />
    )
    expect(getByText("Read")).toBeTruthy()
    expect(getByText("file.ts")).toBeTruthy()
    expect(getByTestId("tool-call-row-Read")).toBeTruthy()
    expect(queryByTestId("tool-body")).toBeNull()
  })

  it("uses an upstream title without repeating the heuristic target", () => {
    const { getByText, queryByText } = render(
      <ToolCallRow
        part={partWith("tool-Read", {
          input: { file_path: "/a/b/file.ts" },
          title: "Reading configuration",
        })}
      />
    )
    expect(getByText("Reading configuration")).toBeTruthy()
    expect(queryByText("file.ts")).toBeNull()
  })

  it("uses Codex app context as a provided title without showing internal ids", () => {
    const { getByText, queryByText } = render(
      <ToolCallRow
        part={partWith("tool-create_event", {
          input: { name: "team sync" },
          toolMetadata: {
            appContext: {
              appName: "Calendar",
              actionName: "create_event",
              connectorId: "calendar-prod",
              linkId: "primary-account",
            },
          },
        })}
      />
    )
    expect(getByText("Calendar · Create event")).toBeTruthy()
    expect(queryByText("calendar-prod")).toBeNull()
    expect(queryByText("primary-account")).toBeNull()
  })

  it("shows protocol capability hints without treating write-capable as high risk", () => {
    const { getByTestId, queryByText } = render(
      <ToolCallRow
        part={partWith("tool-calendar.create_event", {
          title: "Calendar · Create event",
          toolMetadata: { readOnlyHint: false },
        })}
      />
    )
    expect(getByTestId("tool-write-capable").textContent).toContain("writeCapable")
    expect(queryByText(/high risk/i)).toBeNull()
  })

  it("shows read-only hints and hides unknown hints", () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <ToolCallRow
        part={partWith("tool-Read", {
          title: "Read configuration",
          toolMetadata: { readOnlyHint: true },
        })}
      />
    )
    expect(getByTestId("tool-readonly").textContent).toContain("readOnly")
    expect(queryByTestId("tool-write-capable")).toBeNull()

    rerender(
      <ToolCallRow
        part={partWith("tool-Read", {
          title: "Read configuration",
          toolMetadata: { readOnlyHint: null },
        })}
      />
    )
    expect(queryByTestId("tool-readonly")).toBeNull()
    expect(queryByTestId("tool-write-capable")).toBeNull()
  })

  it("expands the body on click (uncontrolled)", () => {
    const { getByRole, getByTestId } = render(
      <ToolCallRow part={part("tool-Bash", { command: "ls -la" })} />
    )
    fireEvent.click(getByRole("button"))
    expect(getByTestId("tool-body")).toBeTruthy()
  })

  it("reflects controlled expanded state and calls onToggle", () => {
    const onToggle = jest.fn()
    const { getByRole, getByTestId, rerender } = render(
      <ToolCallRow
        part={part("tool-MysteryTool", { pattern: "x" })}
        expanded={false}
        onToggle={onToggle}
      />
    )
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(getByRole("button"))
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(
      <ToolCallRow
        part={part("tool-MysteryTool", { pattern: "x" })}
        expanded={true}
        onToggle={onToggle}
      />
    )
    expect(getByTestId("tool-body")).toBeTruthy()
  })

  // The compact row is the *collapsed* affordance; expanding is an explicit
  // user action and must show the same rich content standard mode shows.
  it("expands a registered tool into its dedicated card, not the raw body", () => {
    const { getByRole, getByTestId, queryByTestId } = render(
      <ToolCallRow
        part={partWith("tool-Read", { input: { file_path: "a.ts" }, output: "x = 1" })}
      />
    )
    fireEvent.click(getByRole("button"))
    expect(getByTestId("mcp-read-path").textContent).toContain("a.ts")
    expect(queryByTestId("tool-body")).toBeNull()
  })

  it("expands a tool result carrying image blocks into the image, not a base64 wall", () => {
    const p = {
      type: "tool-mcp__srv__capture",
      state: "output-available",
      input: {},
      output: "[image image/png · 3 B]",
      mcpContent: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    } as never
    const { getByRole, getByTestId, queryByTestId } = render(<ToolCallRow part={p} />)
    fireEvent.click(getByRole("button"))
    expect(getByTestId("image-block").getAttribute("src")).toBe("data:image/png;base64,AAAA")
    expect(queryByTestId("tool-body")).toBeNull()
  })

  it("still falls back to the generic body for an unregistered plain-text tool", () => {
    const { getByRole, getByTestId } = render(
      <ToolCallRow part={partWith("tool-MysteryTool", { output: "raw" })} />
    )
    fireEvent.click(getByRole("button"))
    expect(getByTestId("tool-body")).toBeTruthy()
  })

  it("shows a result-summary chip for grep output (matches)", () => {
    const { getByTestId } = render(
      <ToolCallRow part={partWith("tool-Grep", { input: { pattern: "x" }, output: "a\nb\nc" })} />
    )
    const chip = getByTestId("tool-result-chip")
    expect(chip.getAttribute("data-kind")).toBe("matches")
    expect(chip.textContent).toContain("result.matches")
  })

  it("shows a diff chip for an edit tool", () => {
    const { getByTestId } = render(
      <ToolCallRow
        part={partWith("tool-Edit", { input: { old_string: "a", new_string: "b\nc" } })}
      />
    )
    expect(getByTestId("tool-result-chip").getAttribute("data-kind")).toBe("diff")
  })

  it.each([
    ["tool-Glob", { output: "a\nb" }, "files"],
    ["tool-ls", { output: "a\nb\nc" }, "entries"],
    ["tool-Read", { output: "l1\nl2" }, "lines"],
  ] as const)("shows a %s chip of kind %s", (type, extra, kind) => {
    const { getByTestId } = render(<ToolCallRow part={partWith(type, extra)} />)
    expect(getByTestId("tool-result-chip").getAttribute("data-kind")).toBe(kind)
  })

  it("shows an error chip with the first error line for a failed tool", () => {
    const { getByTestId } = render(
      <ToolCallRow
        part={partWith("tool-Bash", { state: "output-error", errorText: "boom\ntrace" })}
      />
    )
    const chip = getByTestId("tool-result-chip")
    expect(chip.getAttribute("data-kind")).toBe("error")
    expect(chip.textContent).toBe("boom")
  })

  it("renders no chip when there's no natural result summary", () => {
    const { queryByTestId } = render(
      <ToolCallRow part={part("tool-Read", { file_path: "x.ts" })} />
    )
    expect(queryByTestId("tool-result-chip")).toBeNull()
    expect(queryByTestId("tool-running-chip")).toBeNull()
  })

  it("shows a unified line-count chip for a generic/MCP tool with output", () => {
    const { getByTestId } = render(
      <ToolCallRow part={partWith("tool-WebSearch", { output: "a\nb\nc" })} />
    )
    const chip = getByTestId("tool-result-chip")
    expect(chip.getAttribute("data-kind")).toBe("lines")
    expect(chip.textContent).toContain("result.lines")
  })

  it("shows a live progress chip while a tool streams output (no result chip yet)", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolCallRow
        part={partWith("tool-Bash", { state: "input-available", output: "line1\nline2" })}
      />
    )
    const chip = getByTestId("tool-running-chip")
    expect(chip.textContent).toContain("progress.streaming")
    expect(queryByTestId("tool-result-chip")).toBeNull()
  })

  // The activity group's standard/detailed path drives its children by
  // remounting them with a fresh key; a row that ignored `defaultOpen` made the
  // group's expand-all button inert inside a sub-agent tree.
  it("seeds the uncontrolled open state from defaultOpen", () => {
    const { getByTestId } = render(
      <ToolCallRow part={partWith("tool-MysteryTool", { output: "raw" })} defaultOpen />
    )
    expect(getByTestId("tool-body")).toBeTruthy()
  })

  it("still collapses on click after opening via defaultOpen", () => {
    const { getByRole, queryByTestId } = render(
      <ToolCallRow part={partWith("tool-MysteryTool", { output: "raw" })} defaultOpen />
    )
    fireEvent.click(getByRole("button"))
    expect(queryByTestId("tool-body")).toBeNull()
  })

  // A failed call must expand into the parsed trace, not the stringified body.
  it("expands a failed call into its error trace, not the stringified body", () => {
    const { getAllByRole, getAllByText, queryByTestId } = render(
      <ToolCallRow
        part={partWith("tool-MysteryTool", { state: "output-error", errorText: "boom\ntrace" })}
      />
    )
    fireEvent.click(getAllByRole("button")[0])
    expect(queryByTestId("tool-body")).toBeNull()
    // The collapsed row's chip and the expanded trace both carry the message.
    expect(getAllByText(/boom/).length).toBeGreaterThan(0)
  })

  it("exposes the data-status attribute for styling/tests", () => {
    const { getByTestId } = render(
      <ToolCallRow part={part("tool-Read", { file_path: "x.ts" }, "output-error")} />
    )
    expect(getByTestId("tool-call-row-Read").getAttribute("data-status")).toBe("output-error")
  })
})
