import {
  PI_BUILTIN_TOOLS,
  applyConfiguredApprovalToPiPolicy,
  PI_PERMISSION_MARKER,
  PI_TOOL_POLICY_ENV,
  decidePiTool,
  decodePiPermissionTitle,
  decodePiToolPolicy,
  encodePiPermissionTitle,
  PI_PERMISSION_INPUT_LIMIT,
  encodePiToolPolicy,
  resolvePiToolPolicy,
} from "./permission"

const decide = (mode: string | undefined, tool: string, allowed: string[] = []) =>
  decidePiTool(resolvePiToolPolicy(mode, allowed), tool)

describe("resolvePiToolPolicy — the five canonical modes", () => {
  it("default: reads run, writes and shell ask", () => {
    for (const tool of ["read", "grep", "find", "ls"]) {
      expect(decide("default", tool)).toBe("allow")
    }
    for (const tool of ["edit", "write", "bash"]) {
      expect(decide("default", tool)).toBe("ask")
    }
  })

  it("acceptEdits: edits run, but a shell still asks", () => {
    for (const tool of ["read", "edit", "write"]) {
      expect(decide("acceptEdits", tool)).toBe("allow")
    }
    // `bash` can do everything `edit` can and more, so accepting edits is not
    // consent to arbitrary commands.
    expect(decide("acceptEdits", "bash")).toBe("ask")
  })

  it("bypassPermissions: nothing prompts", () => {
    for (const tool of PI_BUILTIN_TOOLS) {
      expect(decide("bypassPermissions", tool)).toBe("allow")
    }
  })

  /**
   * Plan mode DENIES rather than asks. Its promise is that nothing changes; a
   * prompt the user could accept would break that promise.
   */
  it("plan: reads run, everything mutating is denied outright", () => {
    for (const tool of ["read", "grep", "find", "ls"]) {
      expect(decide("plan", tool)).toBe("allow")
    }
    for (const tool of ["edit", "write", "bash"]) {
      expect(decide("plan", tool)).toBe("deny")
    }
  })

  it("dontAsk: only pre-approved tools run, the rest are refused silently", () => {
    expect(decide("dontAsk", "read", ["read", "grep"])).toBe("allow")
    expect(decide("dontAsk", "grep", ["read", "grep"])).toBe("allow")
    // Refused without a prompt — asking would defeat the mode.
    expect(decide("dontAsk", "bash", ["read", "grep"])).toBe("deny")
    expect(decide("dontAsk", "edit", [])).toBe("deny")
  })

  it("treats an unknown mode as the default", () => {
    expect(decide("nonsense", "read")).toBe("allow")
    expect(decide(undefined, "bash")).toBe("ask")
  })
})

describe("resolvePiToolPolicy — fallback for unknown tools", () => {
  /**
   * Extensions can register tools this table has never heard of. The fallback
   * has to inherit the mode's posture rather than defaulting to allow.
   */
  it("applies the mode's posture to a tool it does not know", () => {
    expect(decide("plan", "some_extension_tool")).toBe("deny")
    expect(decide("dontAsk", "some_extension_tool")).toBe("deny")
    expect(decide("default", "some_extension_tool")).toBe("ask")
    expect(decide("acceptEdits", "some_extension_tool")).toBe("ask")
    expect(decide("bypassPermissions", "some_extension_tool")).toBe("allow")
  })

  it("never lets a restrictive mode fall back to allow", () => {
    for (const mode of ["plan", "dontAsk", "default", "acceptEdits"]) {
      expect(resolvePiToolPolicy(mode).fallback).not.toBe("allow")
    }
  })
})

describe("resolvePiToolPolicy — plugin Pi package tools (ADR-0210)", () => {
  const latexTools = ["latex_compile", "latex_preview"]

  it("dontAsk allows a declared package tool only when the session pre-approved it", () => {
    const policy = resolvePiToolPolicy("dontAsk", ["read", "latex_compile"], latexTools)
    expect(decidePiTool(policy, "latex_compile")).toBe("allow")
    expect(decidePiTool(policy, "latex_preview")).toBe("deny")
    // An undeclared extension tool still takes the deny fallback, even when
    // its name was pre-approved: only manifest-declared tools are admitted.
    expect(
      decidePiTool(resolvePiToolPolicy("dontAsk", ["rogue_tool"], latexTools), "rogue_tool")
    ).toBe("deny")
  })

  it("never lets a package re-declare a built-in into allow", () => {
    const policy = resolvePiToolPolicy("dontAsk", ["read"], ["bash"])
    expect(decidePiTool(policy, "bash")).toBe("deny")
  })

  it("leaves package tools on the mode fallback outside dontAsk", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"]) {
      const policy = resolvePiToolPolicy(mode, ["latex_compile"], latexTools)
      expect(decidePiTool(policy, "latex_compile")).toBe(policy.fallback)
    }
  })
})

describe("policy serialization", () => {
  it("round-trips through the env payload", () => {
    const policy = resolvePiToolPolicy("acceptEdits")
    expect(decodePiToolPolicy(encodePiToolPolicy(policy))).toEqual(policy)
  })

  it("rides the already-allowlisted tool-host env prefix", () => {
    // Widening the spawn env allowlist again for one more variable would be a
    // second security surface for no benefit.
    expect(PI_TOOL_POLICY_ENV.startsWith("COGNIA_TOOLHOST_")).toBe(true)
  })

  /**
   * Fail-closed by construction. A policy that cannot be read must never
   * become "allow everything" — that is precisely the silent bypass this
   * whole layer exists to prevent.
   */
  it("denies EVERY tool when the payload is missing or unreadable", () => {
    for (const raw of [undefined, "", "not json", "null", "[1,2]", '{"decisions":3}']) {
      const policy = decodePiToolPolicy(raw)
      // Including the read-only set. This used to fall back to `plan`, which
      // still granted read/grep/find/ls off the back of input that failed to
      // parse — and diverged from the extension that actually enforces it.
      for (const tool of [...PI_BUILTIN_TOOLS, "anything_else"]) {
        expect(decidePiTool(policy, tool)).toBe("deny")
      }
    }
  })

  it("drops decision values it does not recognise instead of trusting them", () => {
    const policy = decodePiToolPolicy(
      JSON.stringify({ mode: "x", decisions: { bash: "yolo", read: "allow" }, fallback: "deny" })
    )
    expect(decidePiTool(policy, "read")).toBe("allow")
    // `yolo` is not a decision, so `bash` falls through to the fallback.
    expect(decidePiTool(policy, "bash")).toBe("deny")
  })

  it("defaults an unrecognised fallback to deny", () => {
    const policy = decodePiToolPolicy(
      JSON.stringify({ mode: "x", decisions: {}, fallback: "whatever" })
    )
    expect(decidePiTool(policy, "read")).toBe("deny")
  })
})

describe("native-tool approval marker", () => {
  it("round-trips the tool and the mode that produced the ask", () => {
    const title = encodePiPermissionTitle({ tool: "bash", mode: "default" })
    expect(title.startsWith(PI_PERMISSION_MARKER)).toBe(true)
    expect(decodePiPermissionTitle(title)).toEqual({ tool: "bash", mode: "default" })
  })

  /**
   * Anything unrecognised must stay an ordinary dialog. Reading a title we do
   * not understand as an approval would let an arbitrary extension's `confirm`
   * render as "allow bash?" — the inverse of what this marker is for.
   */
  it("refuses to read an approval out of anything else", () => {
    for (const title of [
      undefined,
      null,
      42,
      "",
      "Allow bash?",
      // Right prefix, unparseable payload.
      `${PI_PERMISSION_MARKER} not json`,
      // Parseable, but no tool.
      `${PI_PERMISSION_MARKER} {"mode":"default"}`,
      `${PI_PERMISSION_MARKER} {"tool":"","mode":"default"}`,
      // A future version this build does not understand.
      'cognia-permission/v2 {"tool":"bash"}',
      // Prefix without the separating space, so a longer marker cannot match.
      `${PI_PERMISSION_MARKER}x {"tool":"bash"}`,
    ]) {
      expect(decodePiPermissionTitle(title)).toBeUndefined()
    }
  })

  it("carries the call's arguments so the prompt can show what it approves", () => {
    // "Allow bash?" with no command was the whole prompt before this: the user
    // had to approve something that was never on screen.
    const title = encodePiPermissionTitle({
      tool: "bash",
      mode: "acceptEdits",
      input: { command: "echo hi" },
    })
    expect(decodePiPermissionTitle(title)).toEqual({
      tool: "bash",
      mode: "acceptEdits",
      input: { command: "echo hi" },
    })
  })

  it("drops arguments too big for a dialog title instead of sending them", () => {
    // The payload rides inside a title on Pi's stdio wire. A whole file body
    // would push one enormous frame for a preview nobody can read, so it is
    // dropped and the prompt falls back to the extension's own line.
    const huge = "x".repeat(PI_PERMISSION_INPUT_LIMIT + 1)
    const decoded = decodePiPermissionTitle(
      encodePiPermissionTitle({ tool: "write", mode: "default", input: { content: huge } })
    )
    expect(decoded).toEqual({ tool: "write", mode: "default" })
  })

  it("refuses arguments that are not a plain object", () => {
    // An older extension sends none at all; nothing else may become tool input.
    expect(
      decodePiPermissionTitle(`${PI_PERMISSION_MARKER} {"tool":"bash","input":["rm","-rf"]}`)
    ).toEqual({ tool: "bash", mode: "unknown" })
    expect(
      decodePiPermissionTitle(`${PI_PERMISSION_MARKER} {"tool":"bash","input":"echo"}`)
    ).toEqual({ tool: "bash", mode: "unknown" })
  })

  it("defaults an absent mode rather than dropping the approval", () => {
    expect(decodePiPermissionTitle(`${PI_PERMISSION_MARKER} {"tool":"write"}`)).toEqual({
      tool: "write",
      mode: "unknown",
    })
  })
})

/** Stands in for the host's approval-list glob: `*` within a name. */
const matchToolPattern = (pattern: string, toolName: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(
    toolName
  )

describe("applyConfiguredApprovalToPiPolicy", () => {
  it("returns the mode's table untouched without lists", () => {
    const policy = resolvePiToolPolicy("default")
    expect(applyConfiguredApprovalToPiPolicy(policy, {}, matchToolPattern)).toBe(policy)
  })

  it("escalates an always-ask tool and relaxes a bare auto-approval", () => {
    const policy = applyConfiguredApprovalToPiPolicy(
      resolvePiToolPolicy("acceptEdits"),
      {
        requireApprovalFor: ["write"],
        autoApprovePatterns: ["bash", "edit(src/*)"],
      },
      matchToolPattern
    )
    expect(policy.decisions.write).toBe("ask")
    expect(policy.decisions.bash).toBe("allow")
    // A specifier-qualified approval is judged per call, never in the table.
    expect(policy.decisions.edit).toBe("allow")
  })

  it("keeps a no-prompt mode free of prompts and never relaxes a deny", () => {
    const plan = applyConfiguredApprovalToPiPolicy(
      resolvePiToolPolicy("plan"),
      {
        requireApprovalFor: ["read"],
        autoApprovePatterns: ["bash"],
      },
      matchToolPattern
    )
    expect(plan.decisions.read).toBe("deny")
    expect(plan.decisions.bash).toBe("deny")
  })

  it("covers plugin package tools it is told about", () => {
    const policy = applyConfiguredApprovalToPiPolicy(
      resolvePiToolPolicy("default"),
      { autoApprovePatterns: ["latex_*"] },
      matchToolPattern,
      ["latex_build"]
    )
    expect(policy.decisions.latex_build).toBe("allow")
  })
})
