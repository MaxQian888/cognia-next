import { render, screen } from "@testing-library/react"

let overrideRow: unknown = undefined
jest.mock("@/hooks/connectors/use-conversation-overrides", () => ({
  useConversationOverride: (key: string) => (key ? overrideRow : undefined),
}))
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  ),
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
}))

import { parentConversationKeyOf, ThreadMembershipChip } from "./thread-membership-chip"

beforeEach(() => {
  overrideRow = undefined
})

describe("parentConversationKeyOf", () => {
  it("strips the thread id and leaves a plain channel alone", () => {
    expect(parentConversationKeyOf("slack:ad-1:C123:1712.0001")).toBe("slack:ad-1:C123")
    expect(parentConversationKeyOf("matrix:ad-1:!room:server:$root")).toBe(
      "matrix:ad-1:!room:server"
    )
    expect(parentConversationKeyOf("slack:ad-1:C123")).toBeNull()
    expect(parentConversationKeyOf("garbage")).toBeNull()
  })
})

describe("ThreadMembershipChip", () => {
  it("renders nothing for a conversation that is not a thread", () => {
    const { container } = render(<ThreadMembershipChip conversationKey="slack:ad-1:C123" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("links to the parent channel when that conversation is held here", () => {
    overrideRow = { conversationKey: "slack:ad-1:C123" }
    render(<ThreadMembershipChip conversationKey="slack:ad-1:C123:1712.0001" />)
    const link = screen.getByTestId("thread-membership-parent-link")
    expect(link).toHaveAttribute("href", expect.stringContaining("slack%3Aad-1%3AC123"))
    expect(screen.getByTestId("thread-membership-chip")).toHaveAttribute("data-parent", "known")
    expect(screen.getByTestId("tooltip")).toHaveTextContent("t:openParent")
  })

  it("stays a plain badge, and says why, when the parent is unknown", () => {
    render(<ThreadMembershipChip conversationKey="telegram:ad-1:-100:77" />)
    expect(screen.queryByTestId("thread-membership-parent-link")).toBeNull()
    expect(screen.getByTestId("thread-membership-chip")).toHaveAttribute("data-parent", "unknown")
    expect(screen.getByTestId("tooltip")).toHaveTextContent("t:noParent")
  })
})
