/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { render } from "@testing-library/react"

import { ToolDetailBody, isBashToolPart } from "./tool-detail-body"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Keep the generic body cheap (the real one drags in markdown + shiki).
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
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "md" }, content),
}))

// The terminal body owns dock/terminal stores — out of scope here.
jest.mock("@/components/chat/message-parts/terminal-tool-part", () => ({
  TerminalToolBody: ({ part }: { part: { type: string } }) =>
    ReactForMocks.createElement("div", { "data-testid": "terminal-body" }, part.type),
}))

// Stub the error chrome, keep the real `normalizeErrorText` behind it.
jest.mock("@/components/ai-elements/error-trace", () => ({
  ErrorTraceDetails: ({ error, body }: { error: { message: string }; body?: unknown }) =>
    ReactForMocks.createElement(
      "div",
      { "data-testid": "error-trace" },
      error.message,
      body as never
    ),
}))
jest.mock("@/components/error/error-parsed-view", () => ({
  ErrorParsedView: () => ReactForMocks.createElement("div", { "data-testid": "error-parsed" }),
}))

// Real `hasA2UIToolOutput` (routing must be driven by the actual predicate);
// only the surface renderer, which needs the A2UI store, is stubbed.
jest.mock("@/components/a2ui/a2ui-tool-output", () => ({
  ...jest.requireActual("@/components/a2ui/a2ui-tool-output"),
  A2UIToolOutput: ({ toolName }: { toolName: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "a2ui-output" }, toolName),
}))

// Real routing (`isStructuredMcpToolPart`, `toolNameOf`, the generic fallback);
// only the card itself is stubbed, so `sessionId` pass-through is observable.
jest.mock("@/components/chat/message-parts/mcp-tool-card", () => ({
  ...jest.requireActual("@/components/chat/message-parts/mcp-tool-card"),
  MCPToolCard: ({ part, sessionId }: { part: { type: string }; sessionId?: string }) =>
    ReactForMocks.createElement(
      "div",
      { "data-testid": "mcp-card", "data-session-id": sessionId ?? "" },
      part.type
    ),
}))

function part(extra: Record<string, unknown>) {
  return { toolCallId: "call-1", state: "output-available", input: {}, ...extra } as never
}

describe("isBashToolPart", () => {
  it("matches every spelling of Bash", () => {
    expect(isBashToolPart({ type: "tool-Bash" })).toBe(true)
    expect(isBashToolPart({ type: "tool-bash" })).toBe(true)
    expect(isBashToolPart({ type: "tool-mcp__cognia-tools__bash" })).toBe(true)
    // Imported transcripts / CLI handoff carry the dynamic shape.
    expect(isBashToolPart({ type: "dynamic-tool", toolName: "Bash" })).toBe(true)
  })

  it("does not match other tools", () => {
    expect(isBashToolPart({ type: "tool-Read" })).toBe(false)
    expect(isBashToolPart({ type: "tool-BashOutput" })).toBe(false)
    expect(isBashToolPart({ type: "text" })).toBe(false)
  })
})

describe("ToolDetailBody", () => {
  it("routes Bash to the terminal body", () => {
    const { getByTestId } = render(
      <ToolDetailBody part={part({ type: "tool-Bash", input: { command: "ls" } })} />
    )
    expect(getByTestId("terminal-body")).toBeTruthy()
  })

  it("routes a registered tool to its structured card", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolDetailBody part={part({ type: "tool-Read", input: { file_path: "a.ts" } })} />
    )
    expect(getByTestId("mcp-card")).toBeTruthy()
    expect(queryByTestId("tool-body")).toBeNull()
  })

  // `EditCard` / `WriteCard` gate their "review in workbench" action on the
  // session id; the compact row used to drop it, silently hiding the button.
  it("threads sessionId into the structured card", () => {
    const { getByTestId } = render(
      <ToolDetailBody
        part={part({ type: "tool-Edit", input: { file_path: "a.ts" } })}
        sessionId="sess-9"
      />
    )
    expect(getByTestId("mcp-card").getAttribute("data-session-id")).toBe("sess-9")
  })

  it("routes an A2UI-carrying result to the interactive surface", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolDetailBody
        part={part({
          type: "tool-MysteryTool",
          output: '{"type":"createSurface","surfaceId":"s1","surfaceType":"inline"}',
        })}
      />
    )
    expect(getByTestId("a2ui-output")).toBeTruthy()
    expect(queryByTestId("tool-body")).toBeNull()
  })

  it("falls back to the generic body for an unregistered tool", () => {
    const { getByTestId } = render(
      <ToolDetailBody part={part({ type: "tool-MysteryTool", output: "raw text" })} />
    )
    expect(getByTestId("tool-body")).toBeTruthy()
  })

  it("renders parameters + the parsed error trace for a failed call", () => {
    const { getByTestId } = render(
      <ToolDetailBody
        part={part({
          type: "tool-Read",
          state: "output-error",
          input: { file_path: "a.ts" },
          errorText: "ENOENT: no such file",
        })}
      />
    )
    expect(getByTestId("tool-input").textContent).toContain("a.ts")
    expect(getByTestId("error-trace").textContent).toContain("ENOENT")
    expect(getByTestId("error-parsed")).toBeTruthy()
  })

  // A failed Bash must show its trace, not the terminal view — the error branch
  // outranks every renderer that assumes a usable result.
  it("prefers the error trace over the terminal body for a failed Bash", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolDetailBody
        part={part({ type: "tool-Bash", state: "output-error", errorText: "boom" })}
      />
    )
    expect(getByTestId("error-trace")).toBeTruthy()
    expect(queryByTestId("terminal-body")).toBeNull()
  })

  it("omits the parameters block when a failed call carried no input", () => {
    const { queryByTestId, getByTestId } = render(
      <ToolDetailBody
        part={part({ type: "tool-Read", state: "output-error", input: null, errorText: "boom" })}
      />
    )
    expect(queryByTestId("tool-input")).toBeNull()
    expect(getByTestId("error-trace")).toBeTruthy()
  })
})
