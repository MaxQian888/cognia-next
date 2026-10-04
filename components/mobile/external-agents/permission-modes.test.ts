import { supportedPermissionModes } from "@/lib/ai/agent/external/policy/permission-modes"
import enMessages from "@/i18n/messages/en/mobile/externalAgents.json"
import zhMessages from "@/i18n/messages/zh-CN/mobile/externalAgents.json"
import type { AcpPermissionMode } from "@/types/agent/external-agent"

import {
  PERMISSION_MODE_LABEL_KEY,
  effectivePermissionMode,
  permissionModesFor,
} from "./permission-modes"

describe("permission modes", () => {
  it("labels every mode in both locales", () => {
    for (const key of Object.values(PERMISSION_MODE_LABEL_KEY)) {
      expect((enMessages as Record<string, string>)[key]).toBeTruthy()
      expect((zhMessages as Record<string, string>)[key]).toBeTruthy()
    }
  })

  it("offers exactly what the protocol supports", () => {
    expect(permissionModesFor("acp")).toEqual(supportedPermissionModes("acp"))
    expect(permissionModesFor("a2a")).toEqual(supportedPermissionModes("a2a"))
  })

  it("starts an unset mode at default", () => {
    expect(effectivePermissionMode(undefined, "acp")).toBe("default")
  })

  it("keeps a mode the protocol supports and clamps one it does not", () => {
    for (const mode of permissionModesFor("acp")) {
      expect(effectivePermissionMode(mode, "acp")).toBe(mode)
    }
    const a2a = permissionModesFor("a2a")
    const unsupported = (Object.keys(PERMISSION_MODE_LABEL_KEY) as AcpPermissionMode[]).find(
      (mode) => !a2a.includes(mode)
    )
    expect(unsupported).toBeDefined()
    expect(a2a).toContain(effectivePermissionMode(unsupported, "a2a"))
  })
})
