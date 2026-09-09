/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { ConnectionStatusCard, toConnectionCardResult } from "./connection-status-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "configTab.connectionSuccess": "Connected",
      "configTab.connectionFailed": "Connection failed",
      "configTab.latency": "Latency",
      "configTab.lastTested": "Last tested",
      "configTab.lastVerified": "Last verified",
    }
    return map[key] ?? key
  },
}))

describe("ConnectionStatusCard", () => {
  it("reports a pass with its latency", () => {
    render(<ConnectionStatusCard result={{ success: true, outcome: "verified", latency: 42 }} />)
    expect(screen.getByText("Connected")).toBeInTheDocument()
    expect(screen.getByText(/42ms/)).toBeInTheDocument()
  })

  it("reports a failure with the underlying message", () => {
    render(<ConnectionStatusCard result={{ success: false, error: "401 Unauthorized" }} />)
    expect(screen.getByText("Connection failed")).toBeInTheDocument()
    expect(screen.getByText("401 Unauthorized")).toBeInTheDocument()
  })

  // A "limited" outcome means no authoritative request was made (Anthropic in
  // a browser: CORS forces a key-format check only). Read as a pass, that
  // actively misleads.
  describe("limited outcome", () => {
    it("is neither a pass nor a failure", () => {
      render(<ConnectionStatusCard result={{ success: false, outcome: "limited" }} />)
      expect(screen.queryByText("Connected")).not.toBeInTheDocument()
      expect(screen.queryByText("Connection failed")).not.toBeInTheDocument()
    })

    it("spells out that authoritative verification did not happen", () => {
      render(<ConnectionStatusCard result={{ success: false, outcome: "limited" }} />)
      expect(screen.getByText("verificationLimitedHint")).toBeInTheDocument()
    })

    // The headline reached for `configTab.verificationLimited`, which does not
    // exist in either locale, so next-intl rendered the raw key path.
    it("resolves the headline key that actually exists", () => {
      render(<ConnectionStatusCard result={{ success: false, outcome: "limited" }} />)
      expect(screen.getByText("verificationLimited")).toBeInTheDocument()
      expect(screen.queryByText("configTab.verificationLimited")).not.toBeInTheDocument()
    })

    it("still surfaces the underlying detail message", () => {
      render(
        <ConnectionStatusCard
          result={{ success: false, outcome: "limited", error: "API key format valid." }}
        />
      )
      expect(screen.getByText("API key format valid.")).toBeInTheDocument()
    })

    it("keeps a genuine success on the success branch", () => {
      render(<ConnectionStatusCard result={{ success: true, outcome: "verified", latency: 42 }} />)
      expect(screen.getByText("Connected")).toBeInTheDocument()
      expect(screen.queryByText("verificationLimitedHint")).not.toBeInTheDocument()
    })
  })

  it("asks for a re-test when the stored verification went stale", () => {
    // The shape production actually builds: a stale result is `success: false`
    // (`provider-settings.tsx`), because the success branch above claims
    // anything truthy that is not "limited".
    render(
      <ConnectionStatusCard
        result={{ success: false, outcome: "stale", testedAt: 1_700_000_000_000, persisted: true }}
      />
    )
    expect(screen.getByTestId("connection-status-stale")).toBeInTheDocument()
    expect(screen.getByText("verificationStaleHint")).toBeInTheDocument()
    // Stale is a warning, not a pass and not a failure.
    expect(screen.queryByText("Connected")).not.toBeInTheDocument()
    expect(screen.queryByText("Connection failed")).not.toBeInTheDocument()
  })

  it("says a shown result came from the store rather than this session", () => {
    const testedAt = Date.parse("2026-01-02T03:04:05Z")
    render(<ConnectionStatusCard result={{ success: true, testedAt, persisted: true }} />)
    expect(screen.getByText(/Last verified/)).toBeInTheDocument()
    expect(screen.queryByText(/Last tested/)).not.toBeInTheDocument()
  })
})

describe("toConnectionCardResult", () => {
  it("renames the transport fields the card does not speak", () => {
    // `latency_ms` → `latency` and `message` → `error` were copy-pasted across
    // the provider dialogs before this adapter existed, which is exactly how
    // one of them drifted.
    expect(
      toConnectionCardResult({ success: true, latency_ms: 42, message: "ok", outcome: "verified" })
    ).toEqual({ success: true, latency: 42, error: undefined, outcome: "verified" })
  })

  it("keeps the message only when the test failed", () => {
    expect(
      toConnectionCardResult({ success: false, message: "401 Unauthorized", outcome: "failed" })
    ).toEqual({ success: false, latency: undefined, error: "401 Unauthorized", outcome: "failed" })
  })
})
