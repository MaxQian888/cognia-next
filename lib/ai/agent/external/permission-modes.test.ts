import type { AcpPermissionMode, ExternalAgentProtocol } from "@/types/agent/external-agent"
import {
  ALL_PERMISSION_MODES,
  PROTOCOL_PERMISSION_MODE_SUPPORT,
  adaptPermissionMode,
  isPermissionModeSupported,
  supportedPermissionModes,
} from "./permission-modes"

describe("permission-modes", () => {
  describe("supportedPermissionModes", () => {
    it("returns the full canonical set for ACP (the reference backend)", () => {
      expect(supportedPermissionModes("acp")).toEqual(ALL_PERMISSION_MODES)
    })

    it("drops dontAsk for codex-app-server and opencode", () => {
      for (const protocol of ["codex-app-server", "opencode"] as const) {
        const modes = supportedPermissionModes(protocol)
        expect(modes).not.toContain("dontAsk")
        expect(modes).toContain("default")
        expect(modes).toContain("bypassPermissions")
      }
    })

    it("limits fire-and-forget transports to default only", () => {
      for (const protocol of ["a2a", "http", "websocket"] as const) {
        expect(supportedPermissionModes(protocol)).toEqual(["default"])
      }
    })

    it("falls back to the full set for unknown / plugin-contributed protocols", () => {
      expect(supportedPermissionModes("my-plugin:custom" as ExternalAgentProtocol)).toEqual(
        ALL_PERMISSION_MODES
      )
    })

    it("preserves canonical display order in every support list", () => {
      for (const modes of Object.values(PROTOCOL_PERMISSION_MODE_SUPPORT)) {
        const ordered = ALL_PERMISSION_MODES.filter((m) => modes.includes(m))
        expect(modes).toEqual(ordered)
      }
    })
  })

  describe("isPermissionModeSupported", () => {
    it("is true for a natively supported mode", () => {
      expect(isPermissionModeSupported("bypassPermissions", "acp")).toBe(true)
    })

    it("is false for an unsupported mode", () => {
      expect(isPermissionModeSupported("dontAsk", "codex-app-server")).toBe(false)
      expect(isPermissionModeSupported("plan", "a2a")).toBe(false)
    })
  })

  describe("adaptPermissionMode", () => {
    it("passes a supported mode through unchanged", () => {
      expect(adaptPermissionMode("bypassPermissions", "codex-app-server")).toEqual({
        mode: "bypassPermissions",
        requested: "bypassPermissions",
        adapted: false,
      })
    })

    it("clamps dontAsk down to the nearest at-or-below mode (plan) for codex", () => {
      // dontAsk(rank 1) → only `plan`(rank 0) is at-or-below among codex modes.
      expect(adaptPermissionMode("dontAsk", "codex-app-server")).toEqual({
        mode: "plan",
        requested: "dontAsk",
        adapted: true,
      })
      expect(adaptPermissionMode("dontAsk", "opencode").mode).toBe("plan")
    })

    it("never escalates: clamps to the lowest supported mode when all are more permissive", () => {
      // a2a only offers `default`(rank 2); a `plan`(rank 0) request cannot be
      // honoured, so it falls back to the least-permissive supported mode.
      const result = adaptPermissionMode("plan", "a2a")
      expect(result).toEqual({ mode: "default", requested: "plan", adapted: true })
    })

    it("adapts every canonical mode to a supported mode for each protocol", () => {
      const protocols = Object.keys(PROTOCOL_PERMISSION_MODE_SUPPORT) as ExternalAgentProtocol[]
      for (const protocol of protocols) {
        const supported = supportedPermissionModes(protocol)
        for (const mode of ALL_PERMISSION_MODES as AcpPermissionMode[]) {
          const result = adaptPermissionMode(mode, protocol)
          expect(supported).toContain(result.mode)
          expect(result.adapted).toBe(result.mode !== mode)
        }
      }
    })
  })
})

describe("permission modes derived from the capability manifest", () => {
  it("refuses `default` on a transport that cannot ask mid-turn", () => {
    // The DSH SDK client's `respondToPermission` throws: upstream grants every
    // authority at launch. The table used to claim all five modes, so a user
    // could pick "ask me per tool call", see it persisted, and then get
    // workspace-write behaviour with no prompt.
    expect(supportedPermissionModes("dsh-sdk")).not.toContain("default")
    expect(supportedPermissionModes("dsh-sdk")).toContain("plan")
  })

  it("keeps `default` on the pass-through transports, where it is not a promise", () => {
    // For a2a / http / websocket `default` is the only mode and it means "the
    // remote agent owns its policy" — not "Cognia will ask". Stripping it would
    // leave nothing to clamp to.
    for (const protocol of ["a2a", "http", "websocket"] as const) {
      expect(supportedPermissionModes(protocol)).toEqual(["default"])
    }
  })

  it("keeps `default` on protocols that really do carry the question", () => {
    for (const protocol of [
      "acp",
      "codex-app-server",
      "opencode",
      "opencode-v2",
      "pi-rpc",
    ] as const) {
      expect(supportedPermissionModes(protocol)).toContain("default")
    }
  })

  it("never adapts a mode to one the protocol does not support", () => {
    for (const mode of ALL_PERMISSION_MODES) {
      const adapted = adaptPermissionMode(mode, "dsh-sdk")
      expect(supportedPermissionModes("dsh-sdk")).toContain(adapted.mode)
      expect(adapted.mode).not.toBe("default")
    }
  })
})
