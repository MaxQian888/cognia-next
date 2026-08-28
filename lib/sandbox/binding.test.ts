import {
  DEFAULT_SANDBOX_SESSION_BINDING,
  SANDBOX_ISOLATION_RANK,
  bindingRoutesGuiToConnection,
  bindingRoutesWorkspaceToConnection,
  compareSandboxIsolation,
  requiredOperationsForBinding,
  resolveSandboxSessionBinding,
  resolveSandboxTierSource,
  validateSandboxSessionBinding,
} from "./binding"

describe("resolveSandboxSessionBinding", () => {
  it("defaults to everything on the host", () => {
    expect(resolveSandboxSessionBinding({})).toEqual({
      shellTier: "os",
      computerTarget: "local",
    })
  })

  it("omits connectionId entirely when local", () => {
    expect(resolveSandboxSessionBinding({})).not.toHaveProperty("connectionId")
  })

  describe("shell tier precedence", () => {
    it("prefers the session over the character and app settings", () => {
      const binding = resolveSandboxSessionBinding({
        session: { sandboxTier: "microvm" },
        character: { sandboxTier: "os" },
        appSettings: { sandboxTier: "os" },
      })
      expect(binding.shellTier).toBe("microvm")
    })

    it("falls back to the character when the session inherits", () => {
      expect(
        resolveSandboxSessionBinding({
          character: { sandboxTier: "microvm" },
          appSettings: { sandboxTier: "os" },
        }).shellTier
      ).toBe("microvm")
    })

    it("falls back to app settings when both inherit", () => {
      expect(
        resolveSandboxSessionBinding({ appSettings: { sandboxTier: "microvm" } }).shellTier
      ).toBe("microvm")
    })
  })

  describe("computer target precedence", () => {
    it("prefers the session's bound connection", () => {
      const binding = resolveSandboxSessionBinding({
        session: { computerUseTarget: { connectionId: "conn-session" } },
        character: { computerUseTarget: { connectionId: "conn-character" } },
      })
      expect(binding).toMatchObject({ computerTarget: "bound", connectionId: "conn-session" })
    })

    it("lets an explicit session-local target beat a bound character target", () => {
      const binding = resolveSandboxSessionBinding({
        session: { computerUseTarget: "local" },
        character: { computerUseTarget: { connectionId: "conn-character" } },
      })
      expect(binding.computerTarget).toBe("local")
      expect(binding).not.toHaveProperty("connectionId")
    })

    it("falls back to the character when the session inherits", () => {
      expect(
        resolveSandboxSessionBinding({
          character: { computerUseTarget: { connectionId: "conn-c" } },
        })
      ).toMatchObject({ computerTarget: "bound", connectionId: "conn-c" })
    })
  })

  describe("cua-desktop reconciliation", () => {
    it("forces the GUI onto the same connection", () => {
      const binding = resolveSandboxSessionBinding({
        session: {
          sandboxTier: "cua-desktop",
          computerUseTarget: { connectionId: "conn-1" },
        },
      })
      expect(binding).toEqual({
        shellTier: "cua-desktop",
        computerTarget: "bound",
        connectionId: "conn-1",
      })
    })

    it("promotes an explicitly-local GUI target rather than splitting execution", () => {
      const binding = resolveSandboxSessionBinding({
        session: { sandboxTier: "cua-desktop", computerUseTarget: "local" },
      })
      expect(binding.computerTarget).toBe("bound")
      // No connection to promote onto — this is caught by validation, not by
      // silently downgrading the tier.
      expect(binding.connectionId).toBeUndefined()
    })

    it("does NOT force the shell tier when only the GUI is bound", () => {
      const binding = resolveSandboxSessionBinding({
        session: { computerUseTarget: { connectionId: "conn-1" } },
      })
      // Driving a remote desktop while building on the host is legitimate.
      expect(binding.shellTier).toBe("os")
      expect(binding.computerTarget).toBe("bound")
    })
  })
})

describe("validateSandboxSessionBinding", () => {
  it("accepts the host default", () => {
    expect(validateSandboxSessionBinding(DEFAULT_SANDBOX_SESSION_BINDING)).toEqual({ ok: true })
  })

  it("accepts a fully-specified bound binding", () => {
    expect(
      validateSandboxSessionBinding({
        shellTier: "cua-desktop",
        computerTarget: "bound",
        connectionId: "conn-1",
      })
    ).toEqual({ ok: true })
  })

  it("rejects a bound target with no connection", () => {
    const result = validateSandboxSessionBinding({ shellTier: "os", computerTarget: "bound" })
    expect(result).toMatchObject({ ok: false, violation: "bound-target-without-connection" })
  })

  it("rejects cua-desktop with no connection, and says so specifically", () => {
    const result = validateSandboxSessionBinding({
      shellTier: "cua-desktop",
      computerTarget: "bound",
    })
    expect(result).toMatchObject({ ok: false, violation: "cua-desktop-without-connection" })
    expect((result as { message: string }).message).toContain("cua-desktop")
  })

  it("never downgrades — a violation is a refusal, not a fallback to os/local", () => {
    const binding = { shellTier: "cua-desktop" as const, computerTarget: "bound" as const }
    validateSandboxSessionBinding(binding)
    expect(binding.shellTier).toBe("cua-desktop")
    expect(binding.computerTarget).toBe("bound")
  })

  it("accepts a bound GUI with an os shell tier", () => {
    expect(
      validateSandboxSessionBinding({
        shellTier: "os",
        computerTarget: "bound",
        connectionId: "c",
      })
    ).toEqual({ ok: true })
  })
})

describe("routing predicates", () => {
  it("routes the workspace only for a connected cua-desktop binding", () => {
    expect(
      bindingRoutesWorkspaceToConnection({
        shellTier: "cua-desktop",
        computerTarget: "bound",
        connectionId: "c",
      })
    ).toBe(true)
    expect(
      bindingRoutesWorkspaceToConnection({ shellTier: "cua-desktop", computerTarget: "bound" })
    ).toBe(false)
    expect(
      bindingRoutesWorkspaceToConnection({
        shellTier: "microvm",
        computerTarget: "bound",
        connectionId: "c",
      })
    ).toBe(false)
  })

  it("routes the GUI only for a connected bound binding", () => {
    expect(
      bindingRoutesGuiToConnection({
        shellTier: "os",
        computerTarget: "bound",
        connectionId: "c",
      })
    ).toBe(true)
    expect(bindingRoutesGuiToConnection({ shellTier: "os", computerTarget: "local" })).toBe(false)
    expect(bindingRoutesGuiToConnection({ shellTier: "os", computerTarget: "bound" })).toBe(false)
  })
})

describe("requiredOperationsForBinding", () => {
  it("requires nothing for a host-local binding", () => {
    expect(requiredOperationsForBinding(DEFAULT_SANDBOX_SESSION_BINDING)).toEqual([])
  })

  it("requires gui for a bound GUI target", () => {
    expect(
      requiredOperationsForBinding({
        shellTier: "os",
        computerTarget: "bound",
        connectionId: "c",
      })
    ).toEqual(["gui"])
  })

  it("requires both surfaces for cua-desktop", () => {
    expect(
      requiredOperationsForBinding({
        shellTier: "cua-desktop",
        computerTarget: "bound",
        connectionId: "c",
      })
    ).toEqual(["gui", "workspaceExec"])
  })
})

describe("compareSandboxIsolation", () => {
  it("ranks cua-desktop above microvm above os", () => {
    expect(SANDBOX_ISOLATION_RANK.os).toBeLessThan(SANDBOX_ISOLATION_RANK.microvm)
    expect(SANDBOX_ISOLATION_RANK.microvm).toBeLessThan(SANDBOX_ISOLATION_RANK["cua-desktop"])
  })

  it("classifies every direction", () => {
    expect(compareSandboxIsolation("microvm", "microvm")).toBe("same")
    expect(compareSandboxIsolation("os", "microvm")).toBe("stronger")
    // The transition the pin exists to prevent.
    expect(compareSandboxIsolation("microvm", "os")).toBe("weaker")
    expect(compareSandboxIsolation("cua-desktop", "microvm")).toBe("weaker")
    expect(compareSandboxIsolation("microvm", "cua-desktop")).toBe("stronger")
  })
})

describe("resolveSandboxTierSource", () => {
  it("names the rung that supplied the tier", () => {
    expect(resolveSandboxTierSource({ session: { sandboxTier: "microvm" } })).toBe("session")
    expect(resolveSandboxTierSource({ character: { sandboxTier: "microvm" } })).toBe("character")
    expect(resolveSandboxTierSource({ appSettings: { sandboxTier: "microvm" } })).toBe(
      "appSettings"
    )
    expect(resolveSandboxTierSource({})).toBe("fallback")
  })

  it("follows the same precedence as the resolver it explains", () => {
    // Provenance that disagreed with resolution would be worse than none: the
    // pin writes the resolved tier and keys the decision on the source.
    const inputs = {
      session: { sandboxTier: undefined },
      character: { sandboxTier: "microvm" as const },
      appSettings: { sandboxTier: "os" as const },
    }
    expect(resolveSandboxSessionBinding(inputs).shellTier).toBe("microvm")
    expect(resolveSandboxTierSource(inputs)).toBe("character")
  })
})
