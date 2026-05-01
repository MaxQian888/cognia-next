/**
 * Tests for A2UI Tool Output
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIToolOutput, A2UIStructuredOutput, hasA2UIToolOutput } from "./a2ui-tool-output"

const mockProcessPayload = jest.fn()
const mockGetSurface = jest.fn()
const mockProcessMessages = jest.fn()

jest.mock("./a2ui-message-renderer", () => ({
  useA2UIMessageIntegration: jest.fn(() => ({
    processPayload: mockProcessPayload,
    getSurface: mockGetSurface,
  })),
}))

jest.mock("@/hooks/a2ui", () => ({
  useA2UI: jest.fn(() => ({
    processMessages: mockProcessMessages,
    getSurface: mockGetSurface,
  })),
}))

jest.mock("@/lib/a2ui/parser", () => ({
  parseA2UIInput: jest.fn((input: unknown) => {
    if (
      (typeof input === "string" && input.includes("createSurface")) ||
      (Array.isArray(input) && input[0]?.type === "createSurface") ||
      (input && typeof input === "object" && "type" in input && input.type === "createSurface")
    ) {
      return {
        surfaceId: "tool-surface",
        messages: [{ type: "createSurface", surfaceId: "tool-surface", surfaceType: "inline" }],
        errors: [],
      }
    }
    return { surfaceId: null, messages: [], errors: [] }
  }),
}))

jest.mock("./a2ui-surface", () => ({
  A2UISurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid="a2ui-surface">{surfaceId}</div>
  ),
}))

jest.mock("@/lib/utils", () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}))

describe("A2UIToolOutput", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSurface.mockReturnValue({ id: "tool-surface", ready: true })
    mockProcessPayload.mockReturnValue("tool-surface")
  })

  it("renders A2UI tool surface when payload resolves to a surface", () => {
    const payload = { type: "createSurface", surfaceId: "tool-surface" }
    render(<A2UIToolOutput toolId="tool-1" toolName="MyTool" output={payload} />)

    expect(screen.getByTestId("a2ui-surface")).toBeInTheDocument()
    expect(screen.getByText("MyTool")).toBeInTheDocument()
    expect(mockProcessPayload).toHaveBeenCalledWith(payload, "tool:tool-1", "tool-tool-1")
  })

  it("returns null when no A2UI surface is resolved", () => {
    mockProcessPayload.mockReturnValue(null)
    mockGetSurface.mockReturnValue(null)

    const { container } = render(
      <A2UIToolOutput toolId="tool-2" toolName="MyTool" output="plain output" />
    )

    expect(container.firstChild).toBeNull()
  })
})

describe("hasA2UIToolOutput", () => {
  it("returns true when parser detects A2UI messages", () => {
    expect(hasA2UIToolOutput('{"type":"createSurface"}')).toBe(true)
  })

  it("returns false for non-A2UI payload", () => {
    expect(hasA2UIToolOutput("plain text")).toBe(false)
  })
})

describe("A2UIStructuredOutput", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSurface.mockReturnValue({ id: "structured-surface", ready: true })
  })

  it("renders structured output surface", () => {
    const messages = [{ type: "createSurface", surfaceId: "structured-surface" }]

    render(<A2UIStructuredOutput id="structured-1" messages={messages as never} title="Result" />)

    expect(screen.getByText("Result")).toBeInTheDocument()
    expect(screen.getByTestId("a2ui-surface")).toBeInTheDocument()
    expect(mockProcessMessages).toHaveBeenCalledWith(messages)
  })
})
