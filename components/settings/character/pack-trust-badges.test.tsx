import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { formatPackWarnings, PACK_WARNING_MESSAGE_KEY, PackTrustChip } from "./pack-trust-badges"
import type { CharacterPackTrust } from "@/lib/plugin/character-pack/pack-trust"
import type { PluginCharacterPackWarning } from "@/lib/plugin/character-pack/validate-requires"
import enMessages from "@/i18n/messages/en/settings/characters.json"

function renderChip(trust: CharacterPackTrust, showUnsigned: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ settings: { characters: enMessages } }}>
      <PackTrustChip trust={trust} showUnsigned={showUnsigned} />
    </NextIntlClientProvider>
  )
}

const VERIFIED: CharacterPackTrust = {
  state: "verified",
  algo: "ed25519",
  publicKey: "iy9pIM6/7nwKeirJx/3W4CToEMTnayN2K2pFe+iZKZc=",
  fingerprint: "eab649c45f6552313b3de82a80a35b3a169cafd2cf2420379b176ec9fd8ab45d",
  shortFingerprint: "ed25519:ea:b6:49:c4",
  signature: { algo: "ed25519", pubKey: "pk", sig: "sig" },
}

describe("PackTrustChip", () => {
  it("renders a verified chip carrying the fingerprint in its tooltip", () => {
    renderChip(VERIFIED, true)
    const badge = screen.getByText("Verified")
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute("title", expect.stringContaining("ed25519:ea:b6:49:c4"))
  })

  it("renders an unsigned chip for a local pack", () => {
    renderChip({ state: "unsigned" }, true)
    expect(screen.getByText("Unsigned")).toBeInTheDocument()
  })

  it("renders NOTHING for an unsigned plugin-contributed pack", () => {
    // A plugin pack's authenticity comes from the plugin install receipt. An
    // "Unsigned" chip beside it would claim a gap that does not exist.
    const { container } = renderChip({ state: "unsigned" }, false)
    expect(container).toBeEmptyDOMElement()
  })

  it("still shows the verified chip for a plugin pack that happens to be signed", () => {
    // `showUnsigned` suppresses only the unsigned state — a real signature is
    // always worth surfacing, whatever the pack's source.
    renderChip(VERIFIED, false)
    expect(screen.getByText("Verified")).toBeInTheDocument()
  })
})

describe("PACK_WARNING_MESSAGE_KEY", () => {
  it("has a message key for every warning code, and each key exists in en", () => {
    // The Record type makes a missing code a compile error; this asserts the
    // other half — that the key it names is actually present in the bundle.
    const warnings = enMessages.warning as Record<string, string>
    for (const [code, key] of Object.entries(PACK_WARNING_MESSAGE_KEY)) {
      expect(warnings[key]).toBeDefined()
      expect(typeof warnings[key]).toBe("string")
      expect(key).not.toBe(code)
    }
  })
})

describe("formatPackWarnings", () => {
  const t = ((key: string, values?: Record<string, string | number>) =>
    values ? `${key}(${JSON.stringify(values)})` : key) as Parameters<typeof formatPackWarnings>[1]

  it("returns an empty string when there is nothing to report", () => {
    expect(formatPackWarnings([], t)).toBe("")
  })

  it("resolves each code through the message map instead of printing it raw", () => {
    const warnings: PluginCharacterPackWarning[] = [
      { code: "missing-theme-pack", missingId: "plugin-a.pack-b" },
    ]
    const out = formatPackWarnings(warnings, t)
    expect(out).toContain("warning.missingThemePack")
    // The regression: the previous implementation emitted the raw union member.
    expect(out).not.toContain("missing-theme-pack")
  })

  it("wraps character-scoped warnings so the offending character is named", () => {
    const warnings: PluginCharacterPackWarning[] = [
      { code: "missing-provider", missingId: "anthropic", characterLocalId: "c1" },
    ]
    const out = formatPackWarnings(warnings, t)
    expect(out).toContain("warning.characterScope")
    expect(out).toContain("c1")
  })

  it("emits one line per warning", () => {
    const warnings: PluginCharacterPackWarning[] = [
      { code: "missing-skill", missingId: "s1" },
      { code: "missing-connector", missingId: "telegram" },
      { code: "missing-a2ui-catalog", missingId: "cat" },
    ]
    expect(formatPackWarnings(warnings, t).split("\n")).toHaveLength(3)
  })

  it("covers every declared code without falling through to undefined", () => {
    const codes = Object.keys(PACK_WARNING_MESSAGE_KEY) as PluginCharacterPackWarning["code"][]
    const out = formatPackWarnings(
      codes.map((code) => ({ code, missingId: "x" })),
      t
    )
    expect(out).not.toContain("undefined")
    expect(out.split("\n")).toHaveLength(codes.length)
  })
})
