/**
 * Diff-pack-update tests (ADR-0030 v49).
 *
 * Pure function under test, no Dexie or registry plumbing.
 */

import type { Character, PackPristineSnapshot } from "@cognia/agent-config-types"
import type { PluginCharacterDef } from "@/types/plugin/plugin-character-pack"
import { buildPristineSnapshot, diffPackUpdate, PACK_MANAGED_FIELD_LIST } from "./diff-pack-update"

function makeOverlay(overrides: Partial<PluginCharacterDef> = {}): PluginCharacterDef {
  return {
    localId: "alice",
    name: "Alice",
    avatarColor: "oklch(0.7 0.15 250)",
    avatarEmoji: "🧠",
    systemPrompt: "v2 prompt",
    model: "claude-sonnet-4-6",
    description: "Updated description",
    allowedTools: ["Read", "Bash"],
    ...overrides,
  }
}

function makeRow(overrides: Partial<Character> = {}): Character {
  const now = 1700000000000
  return {
    id: "char_clone_alice",
    name: "Alice",
    avatarColor: "oklch(0.7 0.15 250)",
    avatarEmoji: "🧠",
    systemPrompt: "v1 prompt",
    model: "claude-opus-4-7",
    description: "Old description",
    allowedTools: ["Read"],
    sourcePluginId: "demo",
    sourcePackId: "workplace",
    clonedFromPackCharacterId: "cognia-pack:demo:workplace:alice",
    packVersionAtClone: "1.0.0",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("buildPristineSnapshot", () => {
  it("captures every pack-managed field listed in PACK_MANAGED_FIELD_LIST", () => {
    const overlay = makeOverlay({
      modelRouting: {
        plan: "planner-alias",
        execute: "executor-alias",
        utility: "utility-alias",
      },
      executionPolicy: {
        effort: "high",
        maxTurns: 12,
        envBindings: [{ name: "MODE", kind: "plain", value: "safe" }],
      },
      memoryPolicy: {
        operations: { recall: true, create: false, update: false, forget: false },
        readableScopes: ["global"],
        writableScopes: [],
        autoLearn: false,
      },
      avatarImage: { webDataUrl: "data:image/png;base64,AAAA" },
      persona: { tone: "warm" },
      voiceProfile: { provider: "openai", voiceId: "alloy" },
    })
    const snap = buildPristineSnapshot(overlay)
    // Every key the diff considers must round-trip through the snapshot
    // builder so the contract stays a single source of truth.
    for (const field of PACK_MANAGED_FIELD_LIST) {
      expect(Object.prototype.hasOwnProperty.call(snap, field)).toBe(true)
    }
    expect(snap.systemPrompt).toBe("v2 prompt")
    expect(snap.modelRouting?.plan).toBe("planner-alias")
    expect(snap.executionPolicy?.envBindings).toEqual([
      { name: "MODE", kind: "plain", value: "safe" },
    ])
    expect(snap.memoryPolicy?.operations.recall).toBe(true)
    expect(snap.avatarImage?.webDataUrl).toBe("data:image/png;base64,AAAA")
    expect(snap.voiceProfile?.voiceId).toBe("alloy")
  })

  it("deep-copies arrays and nested objects", () => {
    const overlay = makeOverlay({ allowedTools: ["Read"], persona: { tone: "warm" } })
    const snap = buildPristineSnapshot(overlay)
    snap.allowedTools?.push("Bash")
    snap.persona!.tone = "cold"
    expect(overlay.allowedTools).toEqual(["Read"])
    expect(overlay.persona?.tone).toBe("warm")
  })
})

describe("diffPackUpdate", () => {
  it("returns no overwrites and preserves nothing when row already matches", () => {
    const overlay = makeOverlay()
    const snap = buildPristineSnapshot(overlay)
    const row = makeRow({
      systemPrompt: overlay.systemPrompt,
      description: overlay.description,
      model: overlay.model,
      allowedTools: ["Read", "Bash"],
      pristineSnapshot: snap,
    })
    const diff = diffPackUpdate(row, overlay)
    expect(diff.overwrites).toEqual({})
    expect(diff.preserved).toHaveLength(0)
    expect(diff.willOverwrite).toHaveLength(0)
    expect(diff.noBaseline).toBe(false)
  })

  it("overwrites pack-managed fields when user hasn't touched them since baseline", () => {
    const baseline: PackPristineSnapshot = {
      systemPrompt: "v1 prompt",
      description: "Old description",
      model: "claude-opus-4-7",
      allowedTools: ["Read"],
      avatarColor: "oklch(0.7 0.15 250)",
      avatarEmoji: "🧠",
    }
    const row = makeRow({ pristineSnapshot: baseline })
    const overlay = makeOverlay() // newer version
    const diff = diffPackUpdate(row, overlay)
    expect(diff.noBaseline).toBe(false)
    expect(diff.preserved).toHaveLength(0)
    // systemPrompt, description, allowedTools all changed in overlay
    expect(diff.overwrites.systemPrompt).toBe("v2 prompt")
    expect(diff.overwrites.description).toBe("Updated description")
    expect(diff.overwrites.allowedTools).toEqual(["Read", "Bash"])
    // model didn't change vs baseline-equal but overlay value differs from
    // baseline → the row matched baseline so we still overwrite.
    expect(diff.overwrites.model).toBe("claude-sonnet-4-6")
  })

  it("preserves fields the user has edited since baseline", () => {
    const baseline: PackPristineSnapshot = {
      systemPrompt: "v1 prompt",
      description: "Old description",
      model: "claude-opus-4-7",
      allowedTools: ["Read"],
      avatarColor: "oklch(0.7 0.15 250)",
      avatarEmoji: "🧠",
    }
    const row = makeRow({
      systemPrompt: "MY CUSTOM PROMPT", // ← user edited
      description: "Old description", // unchanged
      pristineSnapshot: baseline,
    })
    const overlay = makeOverlay() // newer version
    const diff = diffPackUpdate(row, overlay)
    const preservedFields = diff.preserved.map((p) => p.field)
    expect(preservedFields).toContain("systemPrompt")
    // description un-edited, so it should be overwritten not preserved.
    expect(preservedFields).not.toContain("description")
    expect(diff.overwrites.description).toBe("Updated description")
    expect(diff.overwrites.systemPrompt).toBeUndefined()
  })

  it("falls back to overwrite-all when row has no pristineSnapshot", () => {
    const row = makeRow({ pristineSnapshot: undefined })
    const overlay = makeOverlay()
    const diff = diffPackUpdate(row, overlay)
    expect(diff.noBaseline).toBe(true)
    expect(diff.preserved).toHaveLength(0)
    // Every field that differs between row + overlay is in willOverwrite.
    const willFields = diff.willOverwrite.map((p) => p.field)
    expect(willFields).toContain("systemPrompt")
    expect(willFields).toContain("description")
    expect(willFields).toContain("model")
  })

  it("handles overlay dropping a field (undefined) by writing undefined back", () => {
    const baseline: PackPristineSnapshot = {
      description: "Old description",
      systemPrompt: "v1 prompt",
    }
    const row = makeRow({
      description: "Old description",
      pristineSnapshot: baseline,
    })
    // Overlay no longer ships a description — represents an upstream
    // removal. Apply Update should clear the row field.
    const overlay = makeOverlay({ description: undefined })
    const diff = diffPackUpdate(row, overlay)
    expect(diff.noBaseline).toBe(false)
    expect("description" in diff.overwrites).toBe(true)
    expect(diff.overwrites.description).toBeUndefined()
  })

  it("uses stable structural equality for nested objects", () => {
    // Pin every pack-managed field the row carries to a matching baseline
    // value so the only field under test is the nested computerUseSettings.
    const baseline: PackPristineSnapshot = {
      systemPrompt: "p",
      description: "Old description",
      model: "claude-opus-4-7",
      avatarColor: "oklch(0.7 0.15 250)",
      avatarEmoji: "🧠",
      allowedTools: ["Read"],
      computerUseSettings: { allowedToolIds: ["computer"], requireConsent: true },
    }
    // Same content, different key order — should still register as equal.
    const row = makeRow({
      systemPrompt: "p",
      computerUseSettings: { requireConsent: true, allowedToolIds: ["computer"] },
      pristineSnapshot: baseline,
    })
    const overlay = makeOverlay({
      systemPrompt: "p",
      // Match the row defaults for every field that we don't care about
      // so the test stays focused on the structural-equality property.
      description: "Old description",
      model: "claude-opus-4-7",
      allowedTools: ["Read"],
      computerUseSettings: { allowedToolIds: ["computer"], requireConsent: true },
    })
    const diff = diffPackUpdate(row, overlay)
    expect(diff.preserved).toHaveLength(0)
    expect(diff.overwrites.computerUseSettings).toBeUndefined()
  })

  it("nextSnapshot mirrors the overlay verbatim", () => {
    const overlay = makeOverlay({
      voiceProfile: { provider: "openai", voiceId: "alloy", rate: 1.1 },
      persona: { tone: "warm", exemplarPrompts: ["Hi"] },
    })
    const diff = diffPackUpdate(makeRow(), overlay)
    expect(diff.nextSnapshot.voiceProfile?.voiceId).toBe("alloy")
    expect(diff.nextSnapshot.persona?.tone).toBe("warm")
  })
})
