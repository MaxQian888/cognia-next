import type { SendOptions } from "@cognia/agent-config-types"

import {
  applyUnattendedPermissionProfile,
  classesForPluginTool,
} from "./unattended-permission-options"
import { UNATTENDED_SIDECAR_APPROVAL_TTL_MS } from "./unattended-park"

const ATTESTATION = { schemaVersion: 1 as const, tier: "microvm" as const, verifiedAt: 5 }

function tool(name: string, pluginId: string, access?: "read" | "write") {
  return { name, description: "", jsonSchema: {}, pluginId, ...(access ? { access } : {}) }
}

describe("classesForPluginTool", () => {
  it("derives classes from the declaring plugin's permissions", () => {
    expect(classesForPluginTool(tool("send", "im"), ["connectors:send"])).toEqual(["outbound"])
    expect(classesForPluginTool(tool("read", "vault"), ["secrets:read"])).toEqual(["secrets"])
    expect(classesForPluginTool(tool("rewire", "admin"), ["connectors:manage"])).toEqual([
      "hostConfig",
    ])
    expect(classesForPluginTool(tool("run", "shell"), ["shell:execute"])).toEqual(["workspace"])
    expect(classesForPluginTool(tool("note", "notes"), ["session:read"])).toEqual([])
  })

  it("puts a tool in every class its plugin reaches", () => {
    expect(
      classesForPluginTool(tool("deploy", "ops"), ["secrets:read", "network:upload", "git:write"])
    ).toEqual(["secrets", "outbound", "workspace"])
  })

  it("lets a declared read-only tool out of every class but secret use", () => {
    expect(
      classesForPluginTool(tool("list", "im", "read"), ["connectors:send", "secrets:read"])
    ).toEqual(["secrets"])
  })

  it("classes the host's own tools by what they do", () => {
    expect(classesForPluginTool(tool("deploy_site", "cognia-sites-builtin"), [])).toEqual([
      "outbound",
    ])
    expect(classesForPluginTool(tool("filespace_share", "cognia-filespace"), [])).toEqual([
      "outbound",
    ])
    expect(classesForPluginTool(tool("browser_fill_credential", "browser-tools"), [])).toEqual([
      "secrets",
    ])
    expect(classesForPluginTool(tool("artifact_create", "cognia-artifact-builtin"), [])).toEqual([])
  })
})

describe("applyUnattendedPermissionProfile", () => {
  const deps = {
    pluginPermissions: (pluginId: string) => (pluginId === "im" ? ["connectors:send"] : []),
    attestSandbox: jest.fn((ref: string | undefined) => (ref === "placed" ? ATTESTATION : null)),
  }

  it("leaves an interactive turn untouched", () => {
    const opts: SendOptions = {
      pluginTools: [tool("send", "im")],
      sandboxRuntimeRef: "placed",
    }
    expect(applyUnattendedPermissionProfile(opts, undefined, deps)).toEqual({
      pluginTools: [tool("send", "im")],
      sandboxRuntimeRef: "placed",
    })
    expect(applyUnattendedPermissionProfile(opts, {}, deps)).not.toHaveProperty("permissionProfile")
  })

  it("stamps the resolved profile, the tool classes, the attestation and the TTL", () => {
    const opts: SendOptions = {
      pluginTools: [tool("send", "im"), tool("note", "notes")],
      sandboxRuntimeRef: "placed",
    }
    applyUnattendedPermissionProfile(opts, { permissionProfile: { secrets: "deny" } }, deps)
    expect(opts.permissionProfile).toEqual({
      workspace: "sandbox",
      outbound: "ask",
      secrets: "deny",
      hostConfig: "ask",
    })
    expect(opts.pluginTools).toEqual([
      { ...tool("send", "im"), permissionClasses: ["outbound"] },
      tool("note", "notes"),
    ])
    expect(opts.sandboxAttestation).toEqual(ATTESTATION)
    expect(opts.approvalTtlMs).toBe(UNATTENDED_SIDECAR_APPROVAL_TTL_MS)
  })

  it("never carries an attestation the placement cannot back", () => {
    const opts: SendOptions = {
      sandboxRuntimeRef: "host",
      sandboxAttestation: ATTESTATION,
    }
    applyUnattendedPermissionProfile(opts, { permissionProfile: {} }, deps)
    expect(opts).not.toHaveProperty("sandboxAttestation")
    expect(opts.permissionProfile?.workspace).toBe("sandbox")
  })
})
