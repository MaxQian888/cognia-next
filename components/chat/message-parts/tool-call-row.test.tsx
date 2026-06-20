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

  it("exposes the data-status attribute for styling/tests", () => {
    const { getByTestId } = render(
      <ToolCallRow part={part("tool-Read", { file_path: "x.ts" }, "output-error")} />
    )
    expect(getByTestId("tool-call-row-Read").getAttribute("data-status")).toBe("output-error")
  })
})
