/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

let guardResult: { kind: "ok"; value: undefined } | { kind: "blocked"; reason: string } = {
  kind: "ok",
  value: undefined,
}
const guardCalls: unknown[] = []

jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: () => async (prompt: unknown, action: () => Promise<void>) => {
    guardCalls.push(prompt)
    if (guardResult.kind === "ok") await action()
    return guardResult
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const policy: { value: { revealSecrets?: boolean } | undefined } = { value: undefined }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown }) => T): T =>
    selector({ settings: { biometricRequiredFor: policy.value } }),
}))

import { useSecretReveal } from "./use-secret-reveal"

beforeEach(() => {
  guardCalls.length = 0
  guardResult = { kind: "ok", value: undefined }
  policy.value = undefined
})

function gate() {
  return renderHook(() => useSecretReveal()).result.current
}

describe("useSecretReveal", () => {
  it("reveals without a prompt on the shipped default (row off)", async () => {
    const reveal = jest.fn()
    await expect(gate()(reveal)).resolves.toBe("revealed")
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(guardCalls).toHaveLength(0)
  })

  it("reveals without a prompt when the row is explicitly off", async () => {
    policy.value = { revealSecrets: false }
    const reveal = jest.fn()
    await expect(gate()(reveal)).resolves.toBe("revealed")
    expect(guardCalls).toHaveLength(0)
  })

  it("prompts before revealing when the row is on", async () => {
    policy.value = { revealSecrets: true }
    const reveal = jest.fn()
    await expect(gate()(reveal)).resolves.toBe("revealed")
    expect(guardCalls).toHaveLength(1)
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it("leaves the secret masked when the prompt is refused", async () => {
    policy.value = { revealSecrets: true }
    guardResult = { kind: "blocked", reason: "cancelled" }
    const reveal = jest.fn()
    await expect(gate()(reveal)).resolves.toBe("blocked")
    expect(reveal).not.toHaveBeenCalled()
  })

  it("reveals synchronously enough that a caller can await it once", async () => {
    // The un-gated path must not defer to a later tick — the toggle would
    // otherwise flicker for every user who never turns the row on.
    const seen: string[] = []
    const g = gate()
    const promise = g(() => seen.push("revealed"))
    seen.push("after-call")
    await promise
    expect(seen).toEqual(["revealed", "after-call"])
  })
})

describe("every stored-secret reveal routes through the gate", () => {
  // A sweep, not a spot check: the failure this guards against is a NEW masked
  // field shipping with a bare `setState` toggle, which is invisible to any
  // per-component test. Asserts a non-zero scan count so a broken walk cannot
  // pass as "nothing to report".
  const fs = jest.requireActual("node:fs") as typeof import("node:fs")
  const path = jest.requireActual("node:path") as typeof import("node:path")

  /**
   * Fields holding a password/passphrase the user is TYPING right now, not a
   * secret the app stored on their behalf. Gating these would ask for a
   * fingerprint to check one's own typing.
   */
  const LIVE_INPUT_FIELDS = [
    "components/data/shared/passphrase-input.tsx",
    "components/account/account-lock-screen.tsx",
  ]

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, acc)
      else if (/\.tsx$/.test(entry.name) && !/\.(test|stories)\.tsx$/.test(entry.name))
        acc.push(full)
    }
    return acc
  }

  const MASKED_FIELD = /type=\{[^}]*\?\s*"text"\s*:\s*"password"\}/
  /**
   * A presentational field whose toggle is owned by a parent. The marker names
   * the file holding the gate, so the delegation is checkable rather than
   * assumed.
   */
  const DELEGATION_MARKER = /\/\/ secret-reveal-gate: (\S+)/

  const scanned = walk(path.join(process.cwd(), "components")).map((file) => ({
    rel: path.relative(process.cwd(), file),
    source: fs.readFileSync(file, "utf8"),
  }))

  const revealSurfaces = scanned.filter((f) => MASKED_FIELD.test(f.source))

  it("scans a non-empty set of components", () => {
    expect(scanned.length).toBeGreaterThan(100)
    expect(revealSurfaces.length).toBeGreaterThan(0)
  })

  it("has every masked field either gated or listed as live user input", () => {
    const ungated = revealSurfaces
      .filter((f) => !f.source.includes("use-secret-reveal"))
      .filter((f) => !DELEGATION_MARKER.test(f.source))
      .map((f) => f.rel)
      .filter((rel) => !LIVE_INPUT_FIELDS.includes(rel))
    expect(ungated).toEqual([])
  })

  it("resolves every delegation marker to a file that really holds the gate", () => {
    const delegations = revealSurfaces
      .map((f) => ({ rel: f.rel, target: f.source.match(DELEGATION_MARKER)?.[1] }))
      .filter((d): d is { rel: string; target: string } => Boolean(d.target))
    expect(delegations.length).toBeGreaterThan(0)
    // Report the whole set at once — a per-file assertion stops at the first
    // bad marker and hides the rest.
    const unresolved = delegations.filter(({ target }) => {
      const owner = scanned.find((f) => f.rel === target)
      return !owner?.source.includes("use-secret-reveal")
    })
    expect(unresolved).toEqual([])
  })

  it("keeps the live-input allowlist honest (every entry still exists and is masked)", () => {
    for (const rel of LIVE_INPUT_FIELDS) {
      expect(revealSurfaces.map((f) => f.rel)).toContain(rel)
    }
  })
})
