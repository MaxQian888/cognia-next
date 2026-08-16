import {
  PI_BUILTIN_TOOLS,
  PI_PERMISSION_MARKER,
  PI_TOOL_POLICY_ENV,
  decidePiTool,
  decodePiPermissionTitle,
  decodePiToolPolicy,
  encodePiPermissionTitle,
  encodePiToolPolicy,
  resolvePiToolPolicy,
} from "./pi-permission"

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

/**
 * Drift guard for the shipped extension.
 *
 * `sidecar/` is outside the root tsconfig and outside Jest's test discovery,
 * so the extension carries its own copy of the policy READER (it cannot import
 * from `@/lib`). Jest can still import that file, which lets the two
 * implementations be pinned to each other here — without this, the extension's
 * parser could quietly stop agreeing with the table it is meant to apply.
 */
describe("bundled extension parity", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const extension = require("../../../../sidecar/pi-extension/cognia-pi-extension") as {
    __readPolicyForTests?: (raw: string | undefined) => {
      decisions: Record<string, string>
      fallback: string
    }
    COGNIA_PI_EXTENSION_VERSION: number
    COGNIA_PERMISSION_MARKER: string
  }

  it("exposes a version the adapter's handshake can assert", () => {
    expect(typeof extension.COGNIA_PI_EXTENSION_VERSION).toBe("number")
  })

  /**
   * If these drift, every native-tool approval silently degrades into a generic
   * elicitation form: the allow/deny/allow-always affordances and the approval
   * audit trail disappear, and nothing errors.
   */
  it("uses the same approval marker the mapper matches on", () => {
    expect(extension.COGNIA_PERMISSION_MARKER).toBe(PI_PERMISSION_MARKER)
  })

  it("reads a policy identically to the app-side decoder", () => {
    const read = extension.__readPolicyForTests
    if (!read) throw new Error("extension did not export its policy reader for testing")

    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]) {
      const encoded = encodePiToolPolicy(resolvePiToolPolicy(mode, ["read"]))
      const app = decodePiToolPolicy(encoded)
      const shipped = read(encoded)
      for (const tool of [...PI_BUILTIN_TOOLS, "unknown_extension_tool"]) {
        expect(shipped.decisions[tool] ?? shipped.fallback).toBe(decidePiTool(app, tool))
      }
    }
  })

  it("fails closed on an unreadable policy, exactly as the app decoder does", () => {
    const read = extension.__readPolicyForTests!
    for (const raw of [undefined, "", "not json", "[1,2]"]) {
      const shipped = read(raw)
      const app = decodePiToolPolicy(raw)
      // Deny-everything, so a broken handshake can never widen access — and
      // asserted against the app decoder rather than against a literal, so the
      // two cannot drift apart again the way they had.
      for (const tool of [...PI_BUILTIN_TOOLS, "unknown_extension_tool"]) {
        expect(shipped.decisions[tool] ?? shipped.fallback).toBe("deny")
        expect(decidePiTool(app, tool)).toBe("deny")
      }
    }
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

  it("defaults an absent mode rather than dropping the approval", () => {
    expect(decodePiPermissionTitle(`${PI_PERMISSION_MARKER} {"tool":"write"}`)).toEqual({
      tool: "write",
      mode: "unknown",
    })
  })
})
