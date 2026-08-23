/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"

import {
  EXTERNAL_AGENT_CAPABILITY_EVIDENCE,
  EXTERNAL_AGENT_CAPABILITY_IDS,
  EXTERNAL_CAPABILITY_REASON_KEYS,
} from "@cognia/agent-config-types/external-agent-capability"
import { negotiateCapabilityProfile } from "@/lib/ai/agent/external/capability-profile"
import { externalCapabilityManifest } from "@/lib/ai/agent/external/capability-manifest"

import { ExternalAgentCapabilityMatrix } from "./capability-matrix"

const wrap = (ui: React.ReactNode, messages: typeof en = en) => (
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    {ui}
  </NextIntlClientProvider>
)

describe("ExternalAgentCapabilityMatrix", () => {
  it("says the profile is missing rather than reporting no capabilities", () => {
    render(wrap(<ExternalAgentCapabilityMatrix profile={null} />))
    expect(screen.getByText(/connect the agent to negotiate/i)).toBeInTheDocument()
    expect(screen.queryByTestId("external-agent-capabilities")).not.toBeInTheDocument()
  })

  it("renders a row per capability with its level and evidence", () => {
    const profile = negotiateCapabilityProfile({ protocol: "acp", liveFacts: {} })
    render(wrap(<ExternalAgentCapabilityMatrix profile={profile} />))

    const streaming = screen.getByTestId("capability-streaming")
    expect(streaming).toHaveTextContent("Native")
    expect(streaming).toHaveTextContent("from the protocol specification")

    const mcp = screen.getByTestId("capability-mcp")
    expect(mcp).toHaveTextContent("Native")
  })

  it("shows `unverified` as its own state, not as unsupported", () => {
    const profile = negotiateCapabilityProfile({ protocol: "acp", liveFacts: {} })
    // Nothing measures parallel tool calls on ACP.
    expect(screen.queryByTestId("capability-tools.parallel")).not.toBeInTheDocument()
    render(wrap(<ExternalAgentCapabilityMatrix profile={profile} />))
    expect(screen.getByTestId("capability-tools.parallel")).toHaveTextContent("Unverified")
    expect(screen.getByTestId("capability-tools.parallel")).toHaveTextContent("no evidence")
  })

  it("explains a refusal with the reason the profile recorded", () => {
    const profile = negotiateCapabilityProfile({ protocol: "opencode", liveFacts: {} })
    expect(screen.queryByTestId("capability-mcp")).not.toBeInTheDocument()
    render(wrap(<ExternalAgentCapabilityMatrix profile={profile} />))
    expect(screen.getByTestId("capability-mcp")).toHaveTextContent(
      "the agent protocol has no per-session MCP channel"
    )
  })

  it("resolves a dotted adapter-method reason instead of printing the key", () => {
    // `adapterMethodCapabilityLayer` stamps `adapterMethod.<name>`, and
    // next-intl reads the dot as nesting — so a lookup under `reason.` finds
    // nothing and the raw identifier reached the user in both locales, while
    // the sentences sat one level up under `capabilities.adapterMethod.*`.
    const profile = negotiateCapabilityProfile({
      protocol: "acp",
      adapter: { resumeSession: () => undefined },
      liveFacts: {},
    })
    expect(profile.effective["session.resume"].reasonKey).toBe("adapterMethod.resumeSession")

    render(wrap(<ExternalAgentCapabilityMatrix profile={profile} />))
    const resume = screen.getByTestId("capability-session.resume")
    expect(resume).toHaveTextContent("Cognia's adapter implements resumeSession")
    expect(resume).not.toHaveTextContent("adapterMethod.resumeSession")
  })

  it("surfaces drift as a maintenance signal", () => {
    const profile = negotiateCapabilityProfile({
      protocol: "acp",
      liveFacts: {
        streaming: { level: "unsupported", evidence: "handshake", reasonKey: "notNegotiated" },
      },
    })
    render(wrap(<ExternalAgentCapabilityMatrix profile={profile} />))
    const drift = screen.getByTestId("external-agent-capability-drift")
    expect(drift).toHaveTextContent("streaming declared native, observed unsupported")
  })

  it("distinguishes a declared-only profile from a negotiated one", () => {
    const declared = negotiateCapabilityProfile({ protocol: "acp" })
    const { rerender } = render(wrap(<ExternalAgentCapabilityMatrix profile={declared} />))
    expect(screen.getByText("Declared only")).toBeInTheDocument()

    rerender(wrap(<ExternalAgentCapabilityMatrix profile={{ ...declared, negotiated: true }} />))
    expect(screen.getByText("Negotiated")).toBeInTheDocument()
  })

  it("can hide the unsupported majority", () => {
    const profile = negotiateCapabilityProfile({ protocol: "opencode", liveFacts: {} })
    render(wrap(<ExternalAgentCapabilityMatrix profile={profile} onlyAvailable />))
    expect(screen.queryByTestId("capability-mcp")).not.toBeInTheDocument()
    expect(screen.getByTestId("capability-streaming")).toBeInTheDocument()
  })
})

/**
 * `lint:i18n` cannot see a key built as `t(`level.${x}`)`, so every dynamic key
 * this component can produce is pinned here instead — in BOTH locales, since a
 * missing zh key renders the raw path to a Chinese user and no gate would say so.
 */
describe("dynamic key coverage", () => {
  const catalogues = { en, "zh-CN": zh } as const

  function capabilityMessages(locale: keyof typeof catalogues): Record<string, unknown> {
    const messages = catalogues[locale] as unknown as {
      externalAgent: { capabilities: Record<string, unknown> }
    }
    return messages.externalAgent.capabilities
  }

  it.each(Object.keys(catalogues) as Array<keyof typeof catalogues>)(
    "%s covers every level and evidence grade",
    (locale) => {
      const caps = capabilityMessages(locale)
      const levels = caps.level as Record<string, string>
      const evidence = caps.evidence as Record<string, string>
      for (const level of ["native", "equivalent", "unknown", "unsupported"]) {
        expect(levels[level]).toBeTruthy()
      }
      for (const grade of EXTERNAL_AGENT_CAPABILITY_EVIDENCE) {
        expect(evidence[grade]).toBeTruthy()
      }
    }
  )

  it.each(Object.keys(catalogues) as Array<keyof typeof catalogues>)(
    "%s covers every reasonKey the shipped manifest can produce",
    (locale) => {
      const reasons = capabilityMessages(locale).reason as Record<string, string>
      const manifest = externalCapabilityManifest()
      const used = new Set<string>()
      for (const row of Object.values(manifest.protocols)) {
        for (const cell of Object.values(row.capabilities)) {
          if (cell.reasonKey) used.add(cell.reasonKey)
        }
      }
      for (const entry of Object.values(manifest.presetRefinements)) {
        for (const cell of Object.values(entry.capabilities)) {
          if (cell?.reasonKey) used.add(cell.reasonKey)
        }
      }
      for (const key of used) expect(`${key}=${reasons[key] ?? "MISSING"}`).not.toContain("MISSING")
    }
  )

  it.each(Object.keys(catalogues) as Array<keyof typeof catalogues>)(
    "%s covers every reasonKey the host layers stamp",
    (locale) => {
      const reasons = capabilityMessages(locale).reason as Record<string, string>
      for (const key of Object.values(EXTERNAL_CAPABILITY_REASON_KEYS)) {
        expect(`${key}=${reasons[key] ?? "MISSING"}`).not.toContain("MISSING")
      }
    }
  )

  it.each(Object.keys(catalogues) as Array<keyof typeof catalogues>)(
    "%s covers every adapter method the manifest maps",
    (locale) => {
      const methods = capabilityMessages(locale).adapterMethod as Record<string, string>
      for (const method of Object.values(externalCapabilityManifest().adapterMethodCapabilities)) {
        expect(`${method}=${methods[method as string] ?? "MISSING"}`).not.toContain("MISSING")
      }
    }
  )

  it("keeps the capability id list stable enough to render one row each", () => {
    // A row is keyed by the raw id (a technical identifier, deliberately not
    // translated), so the only requirement is that the vocabulary is non-empty
    // and unique — a duplicate would collide React keys.
    expect(new Set(EXTERNAL_AGENT_CAPABILITY_IDS).size).toBe(EXTERNAL_AGENT_CAPABILITY_IDS.length)
  })
})
