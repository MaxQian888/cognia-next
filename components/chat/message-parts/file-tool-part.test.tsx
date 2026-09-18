/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { FileToolBody, FileToolPart, fileToolKind, isFileToolPart } from "./file-tool-part"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Keep the payload bodies cheap: the row tests assert routing + chrome, not
// shiki/markdown/workbench internals (each covered by its own suite).
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) =>
    ReactForMocks.createElement(
      "pre",
      { "data-testid": "code-block", "data-language": language },
      code
    ),
}))
jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src, alt }: { src: string; alt?: string }) =>
    ReactForMocks.createElement("img", { "data-testid": "image-block", src, alt: alt ?? "" }),
}))
jest.mock("@/components/ai-elements/tool", () => ({
  ToolBody: ({ part }: { part: { type: string } }) =>
    ReactForMocks.createElement("div", { "data-testid": "generic-tool-body" }, part.type),
}))
jest.mock("@/components/ai-elements/shimmer", () => ({
  Shimmer: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    ReactForMocks.createElement("span", { className, "data-testid": "shimmer" }, children),
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  ReadingCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? ReactForMocks.createElement("div", null, children) : null,
}))
jest.mock("@/components/error/error-parsed-view", () => ({
  ErrorParsedView: ({ rawError }: { rawError: unknown }) =>
    ReactForMocks.createElement("div", { "data-testid": "error-parsed" }, String(rawError)),
}))
jest.mock("@/components/chat/message-parts/mcp-renderers/workbench-review-button", () => ({
  WorkbenchReviewButton: ({ absolutePath }: { absolutePath: string }) =>
    ReactForMocks.createElement(
      "button",
      { "data-testid": "workbench-review", "data-path": absolutePath },
      "review"
    ),
}))
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => true,
  openFileInWorkbenchWorkspace: jest.fn(async () => true),
  openEditInWorkbenchReview: jest.fn(async () => true),
}))
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, copy: jest.fn(async () => true) }),
}))

function part(type: string, extra: Record<string, unknown> = {}): ToolUIPart {
  return {
    type,
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    ...extra,
  } as unknown as ToolUIPart
}

describe("fileToolKind / isFileToolPart", () => {
  it("recognises every spelling of the file tools", () => {
    for (const [type, kind] of [
      ["tool-Read", "read"],
      ["tool-read", "read"],
      ["tool-mcp__cognia-tools__read", "read"],
      ["tool-Write", "write"],
      ["tool-Edit", "edit"],
      ["tool-MultiEdit", "edit"],
      ["tool-multi_edit", "edit"],
      ["tool-Grep", "grep"],
      ["tool-Glob", "glob"],
      ["tool-LS", "ls"],
      ["tool-NotebookEdit", "notebook"],
    ] as const) {
      expect(fileToolKind(part(type))).toBe(kind)
      expect(isFileToolPart(part(type))).toBe(true)
    }
  })

  it("recognises the dynamic-tool shape by toolName", () => {
    expect(isFileToolPart(part("dynamic-tool", { toolName: "Read" } as never))).toBe(true)
    expect(
      isFileToolPart(part("dynamic-tool", { toolName: "mcp__cognia-tools__edit" } as never))
    ).toBe(true)
  })

  it("rejects non-file tools and non-tool parts", () => {
    for (const type of ["tool-Bash", "tool-WebFetch", "tool-MysteryTool", "text"]) {
      expect(isFileToolPart(part(type))).toBe(false)
    }
    expect(isFileToolPart(part("dynamic-tool", { toolName: "WebSearch" } as never))).toBe(false)
  })
})

describe("FileToolPart row", () => {
  it("renders verb + path target, collapsed when settled", () => {
    render(
      <FileToolPart
        part={part("tool-Read", {
          input: { file_path: "/repo/src/app.ts" },
          output: "const a = 1\nconst b = 2",
        })}
      />
    )
    const row = screen.getByTestId("file-tool-part")
    expect(row.getAttribute("data-kind")).toBe("read")
    // The verb is an i18n key under chat.toolRow.verb.* — the mock returns keys.
    expect(row.textContent).toContain("verb.read")
    expect(row.textContent).toContain("/repo/src/app.ts")
    expect(screen.getByTestId("file-tool-meta").textContent).toContain('result.lines:{"count":2}')
    // Settled calls start collapsed — the body mounts only on expand.
    expect(screen.queryByTestId("mcp-read-card")).toBeNull()
  })

  it("expands into the read body on click", () => {
    render(
      <FileToolPart
        part={part("tool-Read", {
          input: { file_path: "a.ts" },
          output: "const a = 1",
        })}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /rowAria/ }))
    expect(screen.getByTestId("mcp-read-card")).toBeTruthy()
    expect(screen.getByTestId("code-block").textContent).toBe("const a = 1")
  })

  it("auto-opens while running and shimmers the target", () => {
    render(
      <FileToolPart
        part={part("tool-Read", { state: "input-available", input: { file_path: "a.ts" } })}
      />
    )
    expect(screen.getByTestId("file-tool-part").getAttribute("data-status")).toBe("input-available")
    expect(screen.getByTestId("file-tool-meta").textContent).toBe("status.running")
    expect(screen.getByTestId("shimmer")).toBeTruthy()
    // Running → open, so the body placeholder (path link, no code yet) shows.
    expect(screen.getByTestId("mcp-read-card")).toBeTruthy()
  })

  it("auto-opens on error and shows the parsed trace in the body", () => {
    render(
      <FileToolPart
        part={part("tool-Write", {
          state: "output-error",
          input: { file_path: "a.ts", content: "x" },
          errorText: "EACCES: permission denied",
        })}
      />
    )
    expect(screen.getByTestId("file-tool-error")).toBeTruthy()
    expect(screen.getByTestId("error-parsed").textContent).toContain("EACCES")
    expect(screen.getByTestId("file-tool-meta").className).toContain("text-destructive")
  })

  it("shows an edit-count meta and a workbench review action for Edit", () => {
    render(
      <FileToolPart
        sessionId="s1"
        part={part("tool-Edit", {
          input: { file_path: "a.ts", old_string: "a", new_string: "b" },
          output: "ok",
        })}
      />
    )
    expect(screen.getByTestId("file-tool-meta").textContent).toContain('result.edits:{"count":1}')
    expect(screen.getByTestId("workbench-review").getAttribute("data-path")).toBe("a.ts")
  })

  it("shows match/file counts for the search tools", () => {
    const { unmount } = render(
      <FileToolPart
        part={part("tool-Grep", {
          input: { pattern: "TODO" },
          output: "a.ts:1:x\nb.ts:2:y",
        })}
      />
    )
    expect(screen.getByTestId("file-tool-meta").textContent).toContain('result.matches:{"count":2}')
    unmount()

    render(
      <FileToolPart
        part={part("tool-Glob", {
          input: { pattern: "src/*.ts" },
          output: "src/a.ts\nsrc/b.ts\nsrc/c.ts",
        })}
      />
    )
    expect(screen.getByTestId("file-tool-meta").textContent).toContain('result.files:{"count":3}')
  })

  it("marks a denied call without auto-opening", () => {
    render(
      <FileToolPart
        part={part("tool-Write", {
          state: "output-denied",
          input: { file_path: "a.ts", content: "x" },
        })}
      />
    )
    expect(screen.getByTestId("file-tool-meta").textContent).toBe("status.denied")
    expect(screen.queryByTestId("mcp-write-card")).toBeNull()
  })

  it("offers copy + open-in-workspace for read-only path tools", () => {
    render(
      <FileToolPart
        sessionId="s1"
        part={part("tool-Read", {
          input: { file_path: "a.ts", offset: 12 },
          output: "x",
        })}
      />
    )
    expect(screen.getByTestId("file-tool-copy-target")).toBeTruthy()
    expect(screen.getByTestId("file-tool-open-in-workspace")).toBeTruthy()
  })

  it("shows the file-type glyph for a file target, a folder for LS, none for a pattern", () => {
    const read = render(
      <FileToolPart
        part={part("tool-Read", { input: { file_path: "src/app.tsx" }, output: "x" })}
      />
    )
    expect(screen.getByTestId("file-tool-part").querySelector("[data-file-type]")).toHaveAttribute(
      "data-file-type",
      "react"
    )
    read.unmount()

    const ls = render(
      <FileToolPart part={part("tool-LS", { input: { path: "src" }, output: "src\na/" })} />
    )
    expect(screen.getByTestId("file-tool-part").querySelector("[data-file-type]")).toHaveAttribute(
      "data-file-type",
      "folder"
    )
    ls.unmount()

    // A search tool's target is a glob pattern, not a file — no icon.
    render(
      <FileToolPart part={part("tool-Grep", { input: { pattern: "TODO" }, output: "a.ts:1:x" })} />
    )
    expect(screen.getByTestId("file-tool-part").querySelector("[data-file-type]")).toBeNull()
  })

  it("honours defaultOpen from the activity group's expand-all", () => {
    render(
      <FileToolPart
        defaultOpen
        part={part("tool-Glob", { input: { pattern: "*.ts" }, output: "a.ts" })}
      />
    )
    expect(screen.getByTestId("mcp-glob-card")).toBeTruthy()
  })
})

describe("FileToolBody", () => {
  it("mounts the per-kind body — LS entries here", () => {
    render(
      <FileToolBody
        part={part("tool-LS", { input: { path: "." }, output: "/proj\nsrc/\nfile.ts" })}
      />
    )
    expect(screen.getAllByTestId("mcp-ls-entry")).toHaveLength(2)
  })

  it("falls back to the generic body when the per-kind body rejects the payload", () => {
    // A Read with no path at all: ReadCard returns null, so the generic body
    // stands in rather than leaving the expansion blank.
    render(<FileToolBody part={part("tool-Read", { input: {}, output: "x" })} />)
    expect(screen.getByTestId("generic-tool-body")).toBeTruthy()
  })
})
