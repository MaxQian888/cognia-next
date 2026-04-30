// Barrel re-export check. Verifies every namespace export is wired up so a
// silent omission (e.g., dropping `messages` from the barrel) is caught at
// test time.

import "fake-indexeddb/auto"
import * as barrel from "./index"

describe("lib/db barrel", () => {
  it("re-exports schema helpers at the top level", () => {
    expect(typeof barrel.getDb).toBe("function")
    expect(typeof barrel.whenSeeded).toBe("function")
    expect(typeof barrel.__resetDbForTesting).toBe("function")
  })

  it("re-exports each per-table CRUD module as a namespace", () => {
    const namespaces = [
      "messages",
      "sessions",
      "sessionState",
      "characters",
      "mcpServers",
      "promptPresets",
      "settings",
      "skills",
      "skillResources",
      "teams",
      "trustedWorkspaces",
    ] as const
    for (const ns of namespaces) {
      const mod = (barrel as unknown as Record<string, unknown>)[ns]
      expect(typeof mod).toBe("object")
      expect(mod).not.toBeNull()
    }
  })

  it("characters namespace exposes createCharacter and listCharacters", () => {
    expect(typeof barrel.characters.createCharacter).toBe("function")
    expect(typeof barrel.characters.listCharacters).toBe("function")
  })

  it("settings namespace exposes getSettings and saveSettings", () => {
    expect(typeof barrel.settings.getSettings).toBe("function")
    expect(typeof barrel.settings.saveSettings).toBe("function")
  })

  it("trustedWorkspaces namespace exposes the trust helpers", () => {
    expect(typeof barrel.trustedWorkspaces.trustWorkspace).toBe("function")
    expect(typeof barrel.trustedWorkspaces.isWorkspaceTrusted).toBe("function")
  })

  it("DBAgentTrace is exported as a type-only interface — runtime usage is structural", () => {
    // We can't introspect the type at runtime, but we can confirm a value
    // satisfying the structural shape compiles AND survives at runtime.
    const sample: barrel.DBAgentTrace = {
      id: "1",
      sessionId: "s",
      type: "msg",
      timestamp: 0,
      record: '{"k":"v"}',
    }
    expect(JSON.parse(sample.record)).toEqual({ k: "v" })
  })
})
