import React from "react"
import { act, render } from "@testing-library/react"
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
import { TuiInputProvider, useCriticalInput } from "../../input/input-router"
import { CliI18nProvider } from "../../i18n"
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

describe("approval detail inspection", () => {
  beforeEach(() => __resetInk())

  it("reads the complete arguments and returns without deciding", () => {
    const onResolve = jest.fn()
    const onMove = jest.fn()
    const { container } = render(
      <PermissionOverlay
        req={{
          ...req,
          input: {
            command: "echo begin",
            extra: Array.from({ length: 40 }, (_, i) => `parameter-${i}`).join("\n"),
          },
        }}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={1}
        maxRows={7}
        columns={40}
        onMove={onMove}
        onResolve={onResolve}
      />
    )
    act(() => __fireInput("v", {}))
    act(() => __fireInput("G", {}))
    expect(container.textContent).toContain("parameter-39")
    act(() => __fireInput("", { return: true }))
    expect(onResolve).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Allow always")
    act(() => __fireInput("v", {}))
    act(() => __fireInput("", { escape: true }))
    expect(onResolve).not.toHaveBeenCalled()
    expect(onMove).not.toHaveBeenCalled()
    act(() => __fireInput("", { return: true }))
    expect(onResolve).toHaveBeenCalledWith({ decision: "allow_always" })
  })

  it("exposes the final proposed diff lines without resolving the request", () => {
    const onResolve = jest.fn()
    const { container } = render(
      <PermissionOverlay
        req={
          {
            toolName: "write",
            input: {
              file_path: "long.ts",
              content: Array.from({ length: 50 }, (_, i) => `const line${i} = ${i}`).join("\n"),
            },
          } as never
        }
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        maxRows={7}
        columns={50}
        onMove={() => {}}
        onResolve={onResolve}
      />
    )
    act(() => __fireInput("v", {}))
    act(() => __fireInput("G", {}))
    expect(container.textContent).toContain("const line49 = 49")
    expect(onResolve).not.toHaveBeenCalled()
  })
})

describe("approval viewport navigation", () => {
  beforeEach(() => __resetInk())

  it("retains the selected action in one row and routes navigation", () => {
    const onResolve = jest.fn()
    const onMove = jest.fn()
    const { container } = render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={2}
        maxRows={1}
        onMove={onMove}
        onResolve={onResolve}
      />
    )
    expect(container.textContent).toBe("❯ Deny")
    act(() => __fireInput("", { upArrow: true }))
    act(() => __fireInput("", { downArrow: true }))
    expect(onMove.mock.calls).toEqual([[-1], [1]])
    act(() => __fireInput("", { return: true }))
    expect(onResolve).toHaveBeenCalledWith({ decision: "deny", message: 'Denied "bash".' })
  })

  it("clamps scrolling at both ends and resets reading for a different request", () => {
    const onResolve = jest.fn()
    const props = {
      choices: DEFAULT_PERMISSION_CHOICES,
      index: 0,
      maxRows: 5,
      columns: 80,
      onMove: jest.fn(),
      onResolve,
    }
    const first = {
      ...req,
      description: "",
      input: { command: Array.from({ length: 30 }, (_, i) => `echo line-${i}`).join("\n") },
    }
    const { container, rerender } = render(<PermissionOverlay {...props} req={first} />)
    act(() => __fireInput("v", {}))
    const top = container.textContent
    act(() => __fireInput("", { upArrow: true }))
    expect(container.textContent).toBe(top)
    act(() => __fireInput("", { downArrow: true }))
    expect(container.textContent).not.toBe(top)
    act(() => __fireInput("", { pageDown: true }))
    act(() => __fireInput("", { pageUp: true }))
    act(() => __fireInput("g", {}))
    expect(container.textContent).toBe(top)
    act(() => __fireInput("\u001b[<65;1;1M", {}))
    expect(container.textContent).not.toBe(top)
    act(() => __fireInput("G", {}))
    const bottom = container.textContent
    act(() => __fireInput("", { downArrow: true }))
    expect(container.textContent).toBe(bottom)
    rerender(<PermissionOverlay {...props} req={req} />)
    expect(container.textContent).toContain("v full details")
    expect(onResolve).not.toHaveBeenCalled()
  })
})

it("localizes approval decisions, controls and denial in Chinese", () => {
  __resetInk()
  const onResolve = jest.fn()
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={2}
        onMove={() => {}}
        onResolve={onResolve}
      />
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("允许一次")
  expect(container.textContent).toContain("始终允许")
  expect(container.textContent).toContain("查看完整详情")
  act(() => __fireInput("", { escape: true }))
  expect(onResolve).toHaveBeenCalledWith({ decision: "deny", message: "已拒绝“bash”。" })
})

it("keeps Escape inside the detail reader ahead of the global interrupt route", () => {
  __resetInk()
  const interrupt = jest.fn()
  const onResolve = jest.fn()
  function AppRoutes() {
    useCriticalInput(interrupt, { shouldHandle: (_input, key) => key.escape })
    return (
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={onResolve}
      />
    )
  }
  const { container } = render(
    <TuiInputProvider>
      <AppRoutes />
    </TuiInputProvider>
  )
  act(() => __fireInput("v", {}))
  expect(container.textContent).toContain("Review Run command")
  act(() => __fireInput("", { escape: true }))
  expect(container.textContent).toContain("Allow Run command?")
  expect(interrupt).not.toHaveBeenCalled()
  expect(onResolve).not.toHaveBeenCalled()
  act(() => __fireInput("", { escape: true }))
  expect(interrupt).toHaveBeenCalledTimes(1)
})

it.each([
  { maxRows: 18, index: 0, offset: 1, decision: "allow_always" },
  { maxRows: 1, index: 2, offset: 0, decision: "deny" },
])(
  "selects the clicked approval action at $maxRows rows",
  ({ maxRows, index, offset, decision }) => {
    __resetInk()
    const onResolve = jest.fn()
    const onMove = jest.fn()
    const { getByText } = render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={index}
        maxRows={maxRows}
        onMove={onMove}
        onResolve={onResolve}
      />
    )
    // Supply only the Yoga position jsdom cannot measure; mouse parsing and hit
    // testing follow the production path, including the compact one-action row.
    const actions = getByText(`❯ ${DEFAULT_PERMISSION_CHOICES[index].label}`).parentElement!
    Object.assign(actions, { yogaNode: { getComputedTop: () => 4, getComputedLeft: () => 2 } })
    act(() => __fireInput("\u001b[<64;3;5M", {}))
    act(() => __fireInput("\u001b[<65;3;5M", {}))
    expect(onMove.mock.calls).toEqual([[-1], [1]])
    expect(onResolve).not.toHaveBeenCalled()
    act(() => __fireInput(`\u001b[<0;3;${5 + offset}M`, {}))
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ decision }))
  }
)
