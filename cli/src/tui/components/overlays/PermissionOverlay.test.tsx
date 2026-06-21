import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import {
  choiceToDecision,
  DEFAULT_PERMISSION_CHOICES,
  PermissionOverlay,
  prettyToolName,
  riskLevelFor,
} from "./PermissionOverlay"
import type { PermissionRequestEvent } from "../../state/types"

const req = {
  toolName: "bash",
  input: { command: "rm -rf /tmp/x" },
  displayName: "Run command",
  description: "Executes a shell command",
} as unknown as PermissionRequestEvent

describe("choiceToDecision", () => {
  it("maps deny to a decision with a message", () => {
    expect(choiceToDecision({ label: "Deny", value: "deny" }, "bash")).toEqual({
      decision: "deny",
      message: 'Denied "bash".',
    })
  })
  it("maps allow / allow_always to a plain decision", () => {
    expect(choiceToDecision({ label: "Allow", value: "allow" }, "bash")).toEqual({
      decision: "allow",
    })
    expect(choiceToDecision({ label: "Always", value: "allow_always" }, "bash")).toEqual({
      decision: "allow_always",
    })
  })
})

describe("prettyToolName", () => {
  it("strips the mcp namespace", () => {
    expect(prettyToolName("mcp__cognia-tools__bash")).toBe("bash")
    expect(prettyToolName("mcp__cognia-tools__git_status")).toBe("git_status")
  })
  it("leaves bare / non-mcp names untouched", () => {
    expect(prettyToolName("bash")).toBe("bash")
    expect(prettyToolName("Run command")).toBe("Run command")
  })
})

describe("riskLevelFor", () => {
  it("resolves the shared risk model level for built-in tools (namespaced or bare)", () => {
    expect(riskLevelFor("mcp__cognia-tools__bash")).toBe("high")
    expect(riskLevelFor("ls")).toBe("low")
    expect(riskLevelFor("edit")).toBe("medium")
  })
  it("is undefined for tools outside the catalogue", () => {
    expect(riskLevelFor("mcp__some-plugin__custom")).toBeUndefined()
  })
})

describe("PermissionOverlay", () => {
  beforeEach(() => __resetInk())

  it("strips the namespace and shows the risk level", () => {
    const { container } = render(
      <PermissionOverlay
        req={
          {
            toolName: "mcp__cognia-tools__bash",
            input: { command: "ls" },
          } as unknown as PermissionRequestEvent
        }
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Allow bash?")
    expect(text).not.toContain("mcp__cognia-tools__")
    expect(text).toContain("[high risk]")
  })

  it("shows the tool, summary and description", () => {
    const { container } = render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Run command")
    expect(text).toContain("rm -rf /tmp/x")
    expect(text).toContain("Executes a shell command")
    expect(text).toContain("Allow once")
  })

  it("previews the proposed diff for an edit request", () => {
    const { container } = render(
      <PermissionOverlay
        req={
          {
            toolName: "edit",
            input: {
              file_path: "src/x.ts",
              old_string: "const a = 1",
              new_string: "const a = 2",
            },
          } as unknown as PermissionRequestEvent
        }
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    // The concrete change is shown inline, not just the file path.
    expect(text).toContain("src/x.ts")
    expect(text).toContain("const a = 1")
    expect(text).toContain("const a = 2")
  })

  it("resolves the highlighted decision on Enter", () => {
    const onResolve = jest.fn()
    render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={1}
        onMove={() => {}}
        onResolve={onResolve}
      />
    )
    __fireInput("", { return: true })
    expect(onResolve).toHaveBeenCalledWith({ decision: "allow_always" })
  })

  it("denies on Escape", () => {
    const onResolve = jest.fn()
    render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={onResolve}
      />
    )
    __fireInput("", { escape: true })
    expect(onResolve).toHaveBeenCalledWith({ decision: "deny", message: 'Denied "bash".' })
  })
})
