/**
 * Tests for A2UI Message Renderer
 */

import React from "react"
import { render, screen, renderHook, waitFor } from "@testing-library/react"
import {
  A2UIMessageRenderer,
  hasA2UIContent,
  useA2UIMessageIntegration,
} from "./a2ui-message-renderer"

const mockProcessMessages = jest.fn()
const mockGetSurface = jest.fn()

jest.mock("@/hooks/a2ui", () => ({
  useA2UI: jest.fn(() => ({
    processMessages: mockProcessMessages,
    getSurface: mockGetSurface,
    processMessage: jest.fn(),
    createSurface: jest.fn(),
    deleteSurface: jest.fn(),
    extractAndProcess: jest.fn(),
  })),
}))

jest.mock("@/lib/a2ui/parser", () => ({
  detectA2UIContent: jest.fn((content: string) => content.includes("createSurface")),
  parseA2UIInput: jest.fn((input: unknown, options?: { fallbackSurfaceId?: string }) => {
    if (typeof input === "string" && input.includes("createSurface")) {
      return {
        surfaceId: "extracted-surface",
        messages: [
          { type: "createSurface", surfaceId: "extracted-surface", surfaceType: "inline" },
          { type: "surfaceReady", surfaceId: "extracted-surface" },
        ],
        errors: [],
      }
    }

    return {
      surfaceId: options?.fallbackSurfaceId ?? null,
      messages: [],
      errors: [],
    }
  }),
}))

jest.mock("./a2ui-surface", () => ({
  A2UIInlineSurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid="inline-surface">{surfaceId}</div>
  ),
}))

jest.mock("@/lib/utils", () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}))

describe("A2UIMessageRenderer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSurface.mockReturnValue({ id: "extracted-surface", ready: true })
  })

  it("renders A2UI content when detected", async () => {
    render(<A2UIMessageRenderer content='{"type":"createSurface"}' messageId="msg-1" />)

    await waitFor(() => {
      expect(mockProcessMessages).toHaveBeenCalled()
    })
    expect(screen.getByTestId("inline-surface")).toBeInTheDocument()
  })

  it("renders plain text when no A2UI content is detected", () => {
    render(<A2UIMessageRenderer content="regular message" messageId="msg-2" />)

    expect(screen.getByText("regular message")).toBeInTheDocument()
    expect(screen.queryByTestId("inline-surface")).toBeNull()
  })

  it("supports custom text renderer", () => {
    render(
      <A2UIMessageRenderer
        content="regular message"
        messageId="msg-3"
        textRenderer={(text) => <strong data-testid="custom-text">{text}</strong>}
      />
    )

    expect(screen.getByTestId("custom-text")).toHaveTextContent("regular message")
  })
})

describe("hasA2UIContent", () => {
  it("returns true for A2UI-like content", () => {
    expect(hasA2UIContent('{"type":"createSurface"}')).toBe(true)
  })

  it("returns false for plain content", () => {
    expect(hasA2UIContent("hello")).toBe(false)
  })
})

describe("useA2UIMessageIntegration", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSurface.mockReturnValue({ id: "extracted-surface", ready: true })
  })

  it("deduplicates processing for identical message id + content", () => {
    const { result } = renderHook(() => useA2UIMessageIntegration())

    const firstSurface = result.current.processMessage('{"type":"createSurface"}', "msg-dup")
    const secondSurface = result.current.processMessage('{"type":"createSurface"}', "msg-dup")

    expect(firstSurface).toBe("extracted-surface")
    expect(secondSurface).toBe("extracted-surface")
    expect(mockProcessMessages).toHaveBeenCalledTimes(1)
  })

  it("processes different message ids independently", () => {
    const { result } = renderHook(() => useA2UIMessageIntegration())

    result.current.processMessage('{"type":"createSurface"}', "msg-a")
    result.current.processMessage('{"type":"createSurface"}', "msg-b")

    expect(mockProcessMessages).toHaveBeenCalledTimes(2)
  })
})
