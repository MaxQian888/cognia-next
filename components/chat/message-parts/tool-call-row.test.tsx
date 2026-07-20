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
}))

function part(type: string, input?: unknown, state = "output-available") {
  return { type, input, state } as never
}

function partWith(
  type: string,
  extra: { input?: unknown; output?: unknown; errorText?: unknown; state?: string }
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
        part={part("tool-Grep", { pattern: "x" })}
        expanded={false}
        onToggle={onToggle}
      />
    )
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(getByRole("button"))
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(
      <ToolCallRow part={part("tool-Grep", { pattern: "x" })} expanded={true} onToggle={onToggle} />
    )
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

  it("exposes the data-status attribute for styling/tests", () => {
    const { getByTestId } = render(
      <ToolCallRow part={part("tool-Read", { file_path: "x.ts" }, "output-error")} />
    )
    expect(getByTestId("tool-call-row-Read").getAttribute("data-status")).toBe("output-error")
  })
})
