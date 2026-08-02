/**
 * @jest-environment jsdom
 */
import { VECTOR_BUILTIN_PLUGIN_ID } from "@/lib/claude/vector-builtin-tools"
import {
  grantPermission,
  pluginHasApiPermission,
  revokePermission,
  revokePluginPermissions,
} from "@/lib/plugin/api/permission-api"
import {
  VECTOR_BUILTIN_SEEDED_PERMISSIONS,
  __resetVectorBuiltinPermissionsForTesting,
  ensureVectorBuiltinPermissions,
} from "./agent-tool-permissions"

beforeEach(() => {
  revokePluginPermissions(VECTOR_BUILTIN_PLUGIN_ID)
  __resetVectorBuiltinPermissionsForTesting()
})

describe("ensureVectorBuiltinPermissions", () => {
  it("seeds the three vector permissions", () => {
    ensureVectorBuiltinPermissions()
    for (const permission of VECTOR_BUILTIN_SEEDED_PERMISSIONS) {
      expect(pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, permission)).toBe(true)
    }
  })

  it("seeds exactly vector:read, vector:write and ai:embed", () => {
    expect([...VECTOR_BUILTIN_SEEDED_PERMISSIONS].sort()).toEqual([
      "ai:embed",
      "vector:read",
      "vector:write",
    ])
  })

  it("is idempotent within a process", () => {
    ensureVectorBuiltinPermissions()
    ensureVectorBuiltinPermissions()
    expect(pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, "vector:read")).toBe(true)
  })

  it("does not re-grant a permission the user revoked", () => {
    ensureVectorBuiltinPermissions()
    revokePermission(VECTOR_BUILTIN_PLUGIN_ID, "vector:write")
    expect(pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, "vector:write")).toBe(false)

    // A later dispatch calls this again; the revoke must survive it.
    ensureVectorBuiltinPermissions()
    expect(pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, "vector:write")).toBe(false)
    // Read stays available — this is the read-only vector-memory posture.
    expect(pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, "vector:read")).toBe(true)
  })

  it("does not widen an existing narrowed grant set on first seed", () => {
    grantPermission(VECTOR_BUILTIN_PLUGIN_ID, "vector:read")
    ensureVectorBuiltinPermissions()
    // First seed still fills the rest — the guard only prevents duplicate grants.
    expect(pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, "vector:read")).toBe(true)
    expect(pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, "ai:embed")).toBe(true)
  })
})
