import {
  deriveExternalSessionPermission,
  deriveCapabilityGuards,
  type ExternalSessionPermissionSpec,
} from "./permission-cascade"
import type { AcpCapabilities } from "@/types/agent/external-agent"

describe("deriveExternalSessionPermission", () => {
  it("returns the parent spec verbatim when no child is given", () => {
    const parent: ExternalSessionPermissionSpec = {
      permissionMode: "default",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      mcpServers: [{ name: "fs" }],
    }
    expect(deriveExternalSessionPermission(parent)).toEqual(parent)
  })

  it("clamps the child mode down to the parent (never escalates)", () => {
    expect(
      deriveExternalSessionPermission(
        { permissionMode: "default" },
        { permissionMode: "bypassPermissions" }
      ).permissionMode
    ).toBe("default")
  })

  it("lets the child further-restrict the mode", () => {
    expect(
      deriveExternalSessionPermission({ permissionMode: "acceptEdits" }, { permissionMode: "plan" })
        .permissionMode
    ).toBe("plan")
  })

  it("treats an unconstrained parent as no ceiling for the mode", () => {
    expect(
      deriveExternalSessionPermission({}, { permissionMode: "bypassPermissions" }).permissionMode
    ).toBe("bypassPermissions")
  })

  it("omits the mode when neither side sets one", () => {
    expect(deriveExternalSessionPermission({}, {}).permissionMode).toBeUndefined()
  })

  it("intersects allow-lists so the child cannot widen the surface", () => {
    expect(
      deriveExternalSessionPermission(
        { allowedTools: ["Read", "Grep", "Edit"] },
        { allowedTools: ["Read", "Bash"] }
      ).allowedTools
    ).toEqual(["Read"])
  })

  it("uses the only provided allow-list when one side is unset", () => {
    expect(deriveExternalSessionPermission({ allowedTools: ["Read"] }, {}).allowedTools).toEqual([
      "Read",
    ])
    expect(deriveExternalSessionPermission({}, { allowedTools: ["Grep"] }).allowedTools).toEqual([
      "Grep",
    ])
  })

  it("unions deny-lists (deny always cascades)", () => {
    expect(
      deriveExternalSessionPermission({ disallowedTools: ["Bash"] }, { disallowedTools: ["Write"] })
        .disallowedTools
    ).toEqual(["Bash", "Write"])
  })

  it("intersects MCP servers by name (cannot expose servers the parent lacks)", () => {
    const result = deriveExternalSessionPermission(
      { mcpServers: [{ name: "fs" }, { name: "git" }] },
      { mcpServers: [{ name: "git" }, { name: "net" }] }
    )
    expect(result.mcpServers?.map((s) => s.name)).toEqual(["git"])
  })

  it("falls back to the parent MCP servers when the child does not narrow them", () => {
    const parent: ExternalSessionPermissionSpec = { mcpServers: [{ name: "fs" }] }
    expect(deriveExternalSessionPermission(parent, {}).mcpServers).toEqual([{ name: "fs" }])
  })
})

describe("deriveCapabilityGuards", () => {
  it("allows resume + images when capabilities are unknown", () => {
    expect(deriveCapabilityGuards(undefined)).toEqual({ allowResume: true, allowImages: true })
  })

  it("forbids resume when the agent is single-turn (loadSession=false analogue)", () => {
    const caps: AcpCapabilities = { multiTurn: false }
    expect(deriveCapabilityGuards(caps).allowResume).toBe(false)
  })

  it("allows resume when multiTurn is true", () => {
    expect(deriveCapabilityGuards({ multiTurn: true }).allowResume).toBe(true)
  })

  it("forbids images when supported file types exclude image/*", () => {
    const caps: AcpCapabilities = { supportedFileTypes: ["text/plain", "application/json"] }
    expect(deriveCapabilityGuards(caps).allowImages).toBe(false)
  })

  it("allows images when an image/* type is supported", () => {
    const caps: AcpCapabilities = { supportedFileTypes: ["text/plain", "image/png"] }
    expect(deriveCapabilityGuards(caps).allowImages).toBe(true)
  })

  it("allows images when no supportedFileTypes list is advertised", () => {
    expect(deriveCapabilityGuards({ multiTurn: true }).allowImages).toBe(true)
  })
})
