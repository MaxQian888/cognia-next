/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { safeDiagnosticJson, UnknownPartCard } from "./unknown-part-card"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))
jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe("UnknownPartCard", () => {
  it("keeps an unknown part reachable", () => {
    render(<UnknownPartCard part={{ type: "data-future", value: 1 }} />)
    expect(screen.getByTestId("unknown-part-card")).toHaveAttribute("data-part-type", "data-future")
  })

  it("redacts secrets and caps diagnostic output", () => {
    const output = safeDiagnosticJson(
      { apiKey: "private", payload: "x".repeat(20_000) },
      {
        redacted: "[redacted]",
        circular: "[circular]",
        truncated: "[truncated]",
        unavailable: "[unavailable]",
      }
    )
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("private")
    expect(output).toContain("[truncated]")
    expect(output.length).toBeLessThan(16_500)
  })
})
