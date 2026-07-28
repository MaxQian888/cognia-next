/**
 * @jest-environment jsdom
 *
 * Chrome-budget guard for the conversation header.
 *
 * Deliberately a separate file from `conversation-header.test.tsx`. That suite
 * mocks `@/components/ui/popover`, whose manual mock renders `PopoverContent`
 * unconditionally so the grouped controls stay reachable — but `countControls`
 * depends on a closed overlay contributing nothing to the DOM. One file cannot
 * hold both contracts.
 *
 * The number this pins is the whole point of the overflow refactor: the header
 * used to lay ~20 controls flat in one non-wrapping row, and since
 * `buttonVariants` / `badgeVariants` bake `shrink-0` into their base, none of
 * them compressed. The strip ran past the pane, `ResizablePanel` clipped it,
 * and the trailing gear became unclickable.
 */

import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import type { TriggerPolicy } from "@/types/connectors/policy"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}))
jest.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: (props: Record<string, unknown>) => <button type="button" {...props} />,
}))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  effectiveStatus: () => "open",
  setConversationStatus: jest.fn(),
  setConversationAssignee: jest.fn(),
  setConversationLabels: jest.fn(),
}))
jest.mock("@/hooks/connectors/use-conversation-overrides", () => ({
  useConversationOverride: () => undefined,
}))
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({ useConversationLabels: () => [] }))
// Full shape — `decideBadge` reads `health.current.state`, which the real hook
// always populates.
jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: () => ({
    current: { state: "running", reason: undefined, lastActivityAt: 0 },
    buckets: [],
    lastOk: undefined,
    lastError: undefined,
    pendingOutboundCount: 0,
    breaker: null,
    rateBucket: null,
    atGateBlocks: { total: 0, byReason: [] },
  }),
}))
jest.mock("@/hooks/connectors/use-last-inbound", () => ({
  useLastInboundForConversation: () => Date.now(),
}))
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: () => undefined,
  useCharacters: () => [],
}))
jest.mock("./debug/callback-bindings-inspector", () => ({
  CallbackBindingsInspector: () => null,
}))
jest.mock("./contact-profile-drawer", () => ({ ContactProfileDrawer: () => null }))
jest.mock("./overrides/conversation-override-dialog", () => ({
  ConversationOverrideDialog: () => null,
}))

import { ConversationHeader } from "./conversation-header"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CHROME_BUDGET, countControls } from "@/lib/ui/chrome-budget"

const POLICY: TriggerPolicy = { rules: [], blockers: [], storeUnmatchedInDraftMode: false }

/**
 * Real Radix throughout — no popover/tooltip mocks, so a closed overlay
 * contributes nothing to the DOM, which is exactly what `countControls`
 * measures. `TooltipProvider` mirrors `app/layout.tsx`, which mounts one
 * globally.
 */
function renderHeader() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <ConversationHeader
          conversationKey="telegram:a1:c1"
          sessionId="s1"
          title="Budget check"
          platform="telegram"
          currentMode="auto"
          policy={POLICY}
        />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("ConversationHeader — chrome budget", () => {
  it("stays within the header's permanent-control ceiling", () => {
    const { container } = renderHeader()
    expect(countControls(container.querySelector("header"))).toBeLessThanOrEqual(
      CHROME_BUDGET.inboxConversationHeader
    )
  })

  // If the popover ever renders its content eagerly, the budget above would
  // silently start counting twenty controls again.
  it("keeps the overflow's contents out of the DOM until opened", () => {
    const { queryByTestId } = renderHeader()
    expect(queryByTestId("conversation-header-more")).toBeInTheDocument()
    expect(queryByTestId("conversation-header-overflow")).not.toBeInTheDocument()
    expect(queryByTestId("conversation-header-last-inbound")).not.toBeInTheDocument()
  })
})
