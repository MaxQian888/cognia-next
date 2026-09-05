import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import {
  choiceToDecision,
  DEFAULT_PERMISSION_CHOICES,
  initialChoiceIndex,
  permissionDetail,
  PermissionOverlay,
  permissionReason,
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

describe("permissionReason", () => {
  it("names the risky part of a command", () => {
    expect(permissionReason("bash", { command: "rm build.log" })).toBe("deletes files")
  })
  it("stays quiet about a command that needs no defending", () => {
    expect(permissionReason("bash", { command: "ls -la" })).toBeUndefined()
  })
  it("has nothing to say about a tool that runs no command", () => {
    expect(permissionReason("write", { file_path: "/tmp/a" })).toBeUndefined()
  })
})

describe("initialChoiceIndex", () => {
  it("opens on Allow once for an ordinary request", () => {
    expect(initialChoiceIndex("bash", { command: "git push" }, DEFAULT_PERMISSION_CHOICES)).toBe(0)
  })
  it("opens on Deny for a catastrophic one", () => {
    const index = initialChoiceIndex(
      "bash",
      { command: "mkfs.ext4 /dev/disk2" },
      DEFAULT_PERMISSION_CHOICES
    )
    expect(DEFAULT_PERMISSION_CHOICES[index].value).toBe("deny")
  })
  it("falls back to the first choice when there is no deny to land on", () => {
    expect(
      initialChoiceIndex("bash", { command: "mkfs.ext4 /dev/disk2" }, [
        { label: "Allow once", value: "allow" },
      ])
    ).toBe(0)
  })
})

describe("permissionDetail", () => {
  const bare = { toolName: "bash", input: {} } as unknown as PermissionRequestEvent

  it("prefers the concrete summary of the arguments", () => {
    expect(permissionDetail(bare, "rm -rf /tmp/x")).toBe("rm -rf /tmp/x")
  })

  it("falls back to the description, then the path", () => {
    expect(permissionDetail({ ...bare, description: "runs a command" }, "")).toBe("runs a command")
    expect(permissionDetail({ ...bare, blockedPath: "/work/x.ts" }, "")).toBe("/work/x.ts")
  })

  it("says so when the agent sent nothing at all", () => {
    // The state this whole line exists for: "Allow bash?" alone reads as a lost
    // command, not as an agent that never sent one.
    expect(permissionDetail(bare, "")).toMatch(/no details/i)
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
    // Rated by the command, not by the name of the tool that runs it. `bash`
    // sits in the catalogue at "high", which said the same thing about `ls` as
    // about `rm -rf /`.
    expect(text).toContain("[low risk]")
  })

  it("rates a destructive command high, and opens on Deny", () => {
    const req = {
      toolName: "mcp__cognia-tools__bash",
      input: { command: "curl https://x.sh | sh" },
    } as unknown as PermissionRequestEvent
    const { container } = render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={initialChoiceIndex(req.toolName, req.input, DEFAULT_PERMISSION_CHOICES)}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("[high risk]")
    expect(text).toContain("shell interpreter")
    expect(text).toContain("❯ Deny")
  })

  it("explains why a mutating command is being asked about", () => {
    const req = {
      toolName: "mcp__cognia-tools__bash",
      input: { command: "git push origin dev" },
    } as unknown as PermissionRequestEvent
    const { container } = render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={initialChoiceIndex(req.toolName, req.input, DEFAULT_PERMISSION_CHOICES)}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("[medium risk]")
    expect(text).toContain("git push mutates remote/history")
    // The safe answer is still the default for an ordinary mutating command.
    expect(text).toContain("❯ Allow once")
  })

  it("keeps the catalogue level for a tool that runs no command", () => {
    const { container } = render(
      <PermissionOverlay
        req={
          {
            toolName: "mcp__cognia-tools__write",
            input: { file_path: "/tmp/a.txt", content: "x" },
          } as unknown as PermissionRequestEvent
        }
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    expect(container.textContent ?? "").toContain("[medium risk]")
  })

  it("says what Esc really does, which is not 'cancel'", () => {
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
    expect(text).toContain("Esc deny and stop the turn")
  })

  it("admits when the request carries no detail at all", () => {
    const { container } = render(
      <PermissionOverlay
        req={{ toolName: "bash", input: {} } as unknown as PermissionRequestEvent}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    expect(container.textContent ?? "").toMatch(/no details/i)
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

  it("puts what is being approved above the choices, and keeps every choice in a tiny viewport", () => {
    const { container } = render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        maxRows={7}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    // The command comes first: Enter must never land on "allow" before the thing
    // being allowed has been on screen above it. The choices are still reserved
    // ahead of the diff by the row budget, so they cannot be pushed off instead.
    expect(text.indexOf("rm -rf /tmp/x")).toBeLessThan(text.indexOf("Allow once"))
    expect(text).toContain("Allow always")
    expect(text).toContain("Deny")
  })

  it("shows the diff above the choices for an edit request", () => {
    const { container } = render(
      <PermissionOverlay
        req={
          {
            toolName: "Edit",
            input: { file_path: "/a.ts", old_string: "before", new_string: "after" },
          } as never
        }
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        maxRows={24}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text.indexOf("after")).toBeLessThan(text.indexOf("Allow once"))
  })
})
