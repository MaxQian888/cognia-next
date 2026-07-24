import { CONTROL_COMMAND_SPECS, larkMenuManifest, nativeExposedCommands } from "./registry"
import { READONLY_COMMANDS, parseControlCommand } from "./parse"

describe("control command registry", () => {
  it("keeps the full 16-command surface parse.ts previously hardcoded", () => {
    expect(CONTROL_COMMAND_SPECS.map((s) => s.name).sort()).toEqual(
      [
        "agent",
        "character",
        "commands",
        "dir",
        "goal",
        "help",
        "mode",
        "model",
        "new",
        "reasoning",
        "resume",
        "sessions",
        "status",
        "switch",
        "team",
        "workflow",
      ].sort()
    )
    // No duplicate names — the derived sets would silently shrink.
    expect(new Set(CONTROL_COMMAND_SPECS.map((s) => s.name)).size).toBe(
      CONTROL_COMMAND_SPECS.length
    )
  })

  it("derives the readonly set parse.ts used to hardcode", () => {
    expect([...READONLY_COMMANDS].sort()).toEqual(
      ["commands", "dir", "help", "sessions", "status"].sort()
    )
  })

  it("every spec's usage line starts with its own slash command", () => {
    for (const spec of CONTROL_COMMAND_SPECS) {
      expect(spec.usage.startsWith(`/${spec.name}`)).toBe(true)
    }
  })

  it("exposes exactly the batch-1 native slash commands", () => {
    expect(
      nativeExposedCommands()
        .map((s) => s.name)
        .sort()
    ).toEqual(["help", "new", "sessions", "status", "switch"].sort())
  })

  it("parse.ts still recognises every registered command", () => {
    for (const spec of CONTROL_COMMAND_SPECS) {
      expect(parseControlCommand(`/${spec.name}`)).toEqual({
        kind: "known",
        name: spec.name,
        arg: "",
      })
    }
    expect(parseControlCommand("/definitely-not-a-command")).toEqual({
      kind: "unknown",
      name: "definitely-not-a-command",
    })
  })
})

describe("larkMenuManifest", () => {
  it("derives one SEND_MESSAGE item per natively exposed command", () => {
    const manifest = larkMenuManifest()
    expect(manifest.map((item) => item.name)).toEqual(
      nativeExposedCommands().map((spec) => `/${spec.name}`)
    )
    expect(manifest.every((item) => item.actionType === "SEND_MESSAGE")).toBe(true)
  })

  it("posts the bare command word, never the usage placeholders", () => {
    // `/switch <n|session-id>` as menu text would literally send the angle
    // brackets into the chat.
    const item = larkMenuManifest().find((entry) => entry.name === "/switch")
    expect(item?.text).toBe("/switch")
  })

  it("excludes commands whose nativeExposed flag is off", () => {
    const names = larkMenuManifest().map((item) => item.name)
    expect(names).not.toContain("/model")
    expect(names).not.toContain("/goal")
  })
})
