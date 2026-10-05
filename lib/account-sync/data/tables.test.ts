import { SETTINGS_SYNC } from "@cognia/agent-config-types/settings-sync"
import { ACCOUNT_SYNC_TABLES, DATA_TABLE_CATALOG } from "@/lib/data-governance/table-catalog"

import {
  SYNCED_SETTINGS_KEYS,
  SYNCED_TABLES,
  TABLE_POLICIES,
  isSyncedTable,
  syncedFields,
} from "./tables"

describe("account sync table policies", () => {
  it("cover exactly the tables the data catalog marks account-e2e, with the same class", () => {
    const catalog = [...DATA_TABLE_CATALOG]
      .filter((entry) => entry.accountSync.mode === "account-e2e")
      .map((entry) => [entry.name, entry.accountSync.cls])
      .sort()
    const policies = SYNCED_TABLES.map((table) => [table, TABLE_POLICIES[table].cls]).sort()
    expect(policies).toEqual(catalog)
    expect([...ACCOUNT_SYNC_TABLES.keys()].sort()).toEqual([...SYNCED_TABLES].sort())
  })

  it("name exactly one key field per record table, and never sync it as a field", () => {
    for (const table of SYNCED_TABLES.filter((name) => name !== "settings")) {
      const policy = TABLE_POLICIES[table]
      expect(Object.entries(policy.fields).filter(([, value]) => value === "key")).toEqual([
        ["id", "key"],
      ])
      expect(syncedFields(policy)).not.toContain("id")
    }
  })

  it("keep machine-bound fields on the device", () => {
    expect(TABLE_POLICIES.sessions.fields.workingDir).toBe("local")
    expect(TABLE_POLICIES.sessions.fields.sdkSessionId).toBe("local")
    expect(TABLE_POLICIES.sessions.fields.platformBinding).toBe("local")
    expect(TABLE_POLICIES.memories.fields.vectorDocId).toBe("local")
    expect(TABLE_POLICIES.skills.fields.nativeDirectory).toBe("local")
    expect(TABLE_POLICIES.characters.fields.sandboxPolicy).toBe("local")
    expect(syncedFields(TABLE_POLICIES.messages)).toEqual([
      "createdAt",
      "metadata",
      "parts",
      "role",
      "senderId",
      "senderKind",
      "sessionId",
      "turnKey",
    ])
  })

  it("sync exactly the settings keys cleared as shared", () => {
    const shared = Object.entries(SETTINGS_SYNC)
      .filter(([, entry]) => entry.category === "shared")
      .map(([key]) => key)
      .sort()
    expect([...SYNCED_SETTINGS_KEYS].sort()).toEqual(shared)
    expect(syncedFields(TABLE_POLICIES.settings)).toEqual(shared)
    expect(TABLE_POLICIES.settings.fields.profile).toBe("sync")
    expect(TABLE_POLICIES.settings.fields.gitSettings).toBe("local")
    expect(TABLE_POLICIES.settings.fields.id).toBe("local")
  })

  it("never sync built-ins or project-bound memories", () => {
    expect(TABLE_POLICIES.characters.syncsRow({ isBuiltIn: true })).toBe(false)
    expect(TABLE_POLICIES.characters.syncsRow({ isBuiltIn: false })).toBe(true)
    expect(TABLE_POLICIES.skills.syncsRow({ source: "builtin" })).toBe(false)
    expect(TABLE_POLICIES.skills.syncsRow({ isBuiltIn: true, source: "custom" })).toBe(false)
    expect(TABLE_POLICIES.skills.syncsRow({ source: "custom" })).toBe(true)
    expect(TABLE_POLICIES.memories.syncsRow({ projectId: "p1" })).toBe(false)
    expect(TABLE_POLICIES.memories.syncsRow({ projectId: undefined })).toBe(true)
    expect(TABLE_POLICIES.sessions.syncsRow({})).toBe(true)
  })

  it("diff every whole-row write except messages", () => {
    expect(SYNCED_TABLES.filter((table) => !TABLE_POLICIES[table].diff)).toEqual(["messages"])
  })

  it("recognize synced table names only", () => {
    expect(isSyncedTable("sessions")).toBe(true)
    expect(isSyncedTable("workflows")).toBe(false)
    expect(isSyncedTable("constructor")).toBe(false)
  })
})
