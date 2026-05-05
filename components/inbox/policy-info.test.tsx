/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// Tooltip stubbed — TooltipContent renders directly in DOM
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children, ...rest }: { children: React.ReactNode; [k: string]: unknown }) => (
    <div {...rest}>{children}</div>
  ),
}))

import { PolicyInfo } from "./policy-info"
import type { TriggerPolicy } from "@/types/connectors/policy"

function makePolicy(overrides: Partial<TriggerPolicy> = {}): TriggerPolicy {
  return {
    rules: [],
    blockers: [],
    storeUnmatchedInDraftMode: false,
    ...overrides,
  }
}

describe("PolicyInfo", () => {
  it("renders trigger and policy info chip", () => {
    render(<PolicyInfo policy={makePolicy()} />)
    expect(screen.getByTestId("policy-info-trigger")).toBeInTheDocument()
  })

  it("shows 'No trigger rules configured.' when policy is empty", () => {
    render(<PolicyInfo policy={makePolicy()} />)
    expect(screen.getByText("No trigger rules configured.")).toBeInTheDocument()
  })

  it("summarises self-mention + reply-to-bot rules", () => {
    render(
      <PolicyInfo
        policy={makePolicy({
          rules: [{ kind: "self-mention" }, { kind: "reply-to-bot" }],
        })}
      />
    )
    // The policy text is rendered inside the TooltipContent
    expect(screen.getByTestId("policy-info-tooltip")).toHaveTextContent(/@mention/i)
    expect(screen.getByTestId("policy-info-tooltip")).toHaveTextContent(/Reply-to-bot/i)
  })

  it("includes rate-limit blocker description", () => {
    render(
      <PolicyInfo
        policy={makePolicy({
          blockers: [{ kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 20 }],
        })}
      />
    )
    expect(screen.getByText(/rate-limited to 5\/min per user/i)).toBeInTheDocument()
  })

  it("shows keyword rules with word list", () => {
    render(
      <PolicyInfo
        policy={makePolicy({
          rules: [{ kind: "keyword", words: ["hello", "help"], caseInsensitive: true }],
        })}
      />
    )
    expect(screen.getByText(/keywords: hello, help/i)).toBeInTheDocument()
  })
})
