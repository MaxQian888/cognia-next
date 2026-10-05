import { formatRecoveryKey } from "@cognia/sync-protocol"

import {
  CONFIRMATION_CHARACTERS,
  confirmsRecoveryKey,
  pickConfirmationPositions,
  recoveryKitContents,
  recoveryKitFileName,
} from "./recovery-kit"

const KEY = formatRecoveryKey(Uint8Array.from({ length: 16 }, (_, i) => i * 13))

describe("recovery-key confirmation", () => {
  it("asks for four distinct positions", () => {
    for (let i = 0; i < 20; i++) {
      const positions = pickConfirmationPositions()
      expect(positions).toHaveLength(CONFIRMATION_CHARACTERS)
      expect(new Set(positions).size).toBe(CONFIRMATION_CHARACTERS)
      expect(positions.every((p) => p >= 0 && p < 26)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    }
    const sequence = [3, 3, 0, 25, 7]
    expect(pickConfirmationPositions(() => sequence.shift()!)).toEqual([0, 3, 7, 25])
  })

  it("accepts the right characters, forgiving case and look-alikes", () => {
    const characters = KEY.replaceAll("-", "")
    const positions = [0, 5, 12, 25]
    const typed = positions.map((p) => characters[p]!.toLowerCase())
    expect(confirmsRecoveryKey(KEY, positions, typed)).toBe(true)
    const wrong = [...typed]
    wrong[1] = characters[5] === "A" ? "B" : "A"
    expect(confirmsRecoveryKey(KEY, positions, wrong)).toBe(false)
    expect(confirmsRecoveryKey(KEY, positions, typed.slice(1))).toBe(false)
    expect(confirmsRecoveryKey(KEY, positions, ["", ...typed.slice(1)])).toBe(false)
    expect(confirmsRecoveryKey("short", positions, typed)).toBe(false)
  })
})

describe("recovery kit", () => {
  it("lays out the key with the caller's words", () => {
    const contents = recoveryKitContents({
      recoveryKeyText: KEY,
      account: "ada@example.com",
      createdAt: new Date("2026-10-05T12:00:00Z"),
      text: {
        title: "Cognia sync recovery key",
        intro: "Keep this safe.",
        keyLabel: "Recovery key",
        accountLabel: "Account",
        createdLabel: "Created",
        instructions: ["Print it.", "Never share it."],
      },
    })
    expect(contents).toContain(`Recovery key: ${KEY}`)
    expect(contents).toContain("Account: ada@example.com")
    expect(contents).toContain("Created: 2026-10-05")
    expect(contents).toContain("2. Never share it.")
    expect(recoveryKitFileName(new Date("2026-10-05T12:00:00Z"))).toBe(
      "cognia-sync-recovery-key-2026-10-05.txt"
    )
  })
})
