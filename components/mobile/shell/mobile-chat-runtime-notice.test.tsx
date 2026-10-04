/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatRuntimeGate } from "@/hooks/chat/use-chat-runtime-gate"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const EMPTY_QUEUE = {
  pending: 0,
  sending: 0,
  stuck: 0,
  awaitingApproval: false,
  hasRows: false,
  visible: false,
  message: "",
}
let mockQueue = EMPTY_QUEUE
jest.mock("@/hooks/use-outbound-queue-status", () => ({
  useOutboundQueueStatus: () => mockQueue,
}))
jest.mock("@/components/mobile/outbound-queue-sheet", () => ({
  OutboundQueueSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="queue-sheet" /> : null,
}))

import {
  isConnectionNoticeClaimed,
  isQueueNoticeClaimed,
} from "@/lib/runtime/connection-notice-claim"
import { MobileChatRuntimeNotice, MobileChatRuntimeStrip } from "./mobile-chat-runtime-notice"

function gate(overrides: Partial<ChatRuntimeGate>): ChatRuntimeGate {
  return {
    availability: { state: "requires-pairing", reason: "companion-not-paired" },
    composerDisabled: true,
    recovery: { kind: "route", href: "/pair?mode=add" },
    connecting: false,
    ...overrides,
  }
}

describe("<MobileChatRuntimeNotice />", () => {
  it("explains a pairing gap and routes to pairing", async () => {
    const user = userEvent.setup()
    const onNavigate = jest.fn()
    render(<MobileChatRuntimeNotice gate={gate({})} onNavigate={onNavigate} onOpenSettings={jest.fn()} />)
    const notice = screen.getByTestId("chat-runtime-notice")
    expect(notice).toHaveAttribute("role", "status")
    expect(notice).toHaveTextContent("title")
    expect(notice).toHaveTextContent("states.requiresPairing")
    const action = screen.getByTestId("chat-runtime-notice-action")
    expect(action).toHaveTextContent("actions.pair")
    expect(action).toHaveClass("h-11", "w-full")
    await user.click(action)
    expect(onNavigate).toHaveBeenCalledWith("/pair?mode=add")
  })

  it("says the host is reconnecting rather than down, and opens local settings", async () => {
    const user = userEvent.setup()
    const onOpenSettings = jest.fn()
    render(
      <MobileChatRuntimeNotice
        gate={gate({
          availability: { state: "offline", reason: "connection-offline" },
          recovery: { kind: "local-settings", section: "companion" },
          connecting: true,
        })}
        onNavigate={jest.fn()}
        onOpenSettings={onOpenSettings}
      />
    )
    const notice = screen.getByTestId("chat-runtime-notice")
    expect(notice).toHaveTextContent("connectionTitle")
    expect(notice).toHaveTextContent("connecting")
    await user.click(screen.getByTestId("chat-runtime-notice-action"))
    expect(onOpenSettings).toHaveBeenCalledWith("companion")
  })

  it("offers no action when there is nothing the user can do", () => {
    render(
      <MobileChatRuntimeNotice
        gate={gate({
          availability: { state: "unsupported", reason: "requires-companion" },
          recovery: { kind: "none" },
        })}
        onNavigate={jest.fn()}
        onOpenSettings={jest.fn()}
      />
    )
    expect(screen.getByTestId("chat-runtime-notice")).toHaveTextContent("states.unsupported")
    expect(screen.queryByTestId("chat-runtime-notice-action")).toBeNull()
  })
})

describe("<MobileChatRuntimeStrip />", () => {
  afterEach(() => {
    mockQueue = EMPTY_QUEUE
  })

  it("carries the outbound queue on its line and opens the queue list", async () => {
    const user = userEvent.setup()
    mockQueue = { ...EMPTY_QUEUE, pending: 2, hasRows: true, visible: true, message: "2 queued" }
    render(
      <MobileChatRuntimeStrip
        gate={gate({
          availability: { state: "offline", reason: "connection-offline" },
          recovery: { kind: "local-settings", section: "companion" },
          connecting: true,
        })}
        onNavigate={jest.fn()}
        onOpenSettings={jest.fn()}
      />
    )
    const detail = screen.getByTestId("chat-runtime-strip-detail")
    expect(detail).toHaveTextContent("2 queued")
    expect(detail).not.toHaveTextContent("strip.cacheOnly")
    expect(detail).toHaveClass("text-muted-foreground")
    await user.click(screen.getByTestId("chat-runtime-strip-queue"))
    expect(screen.getByTestId("queue-sheet")).toBeInTheDocument()
  })

  it("marks stopped rows as needing a decision", () => {
    mockQueue = { ...EMPTY_QUEUE, stuck: 1, hasRows: true, visible: true, message: "1 needs you" }
    render(<MobileChatRuntimeStrip gate={gate({})} onNavigate={jest.fn()} onOpenSettings={jest.fn()} />)
    expect(screen.getByTestId("chat-runtime-strip-detail")).toHaveClass("text-destructive")
  })

  it("says an approval wait without offering an empty list", () => {
    mockQueue = { ...EMPTY_QUEUE, awaitingApproval: true, visible: true, message: "approve 42" }
    render(<MobileChatRuntimeStrip gate={gate({})} onNavigate={jest.fn()} onOpenSettings={jest.fn()} />)
    expect(screen.getByTestId("chat-runtime-strip-detail")).toHaveTextContent("approve 42")
    expect(screen.queryByTestId("chat-runtime-strip-queue")).not.toBeInTheDocument()
  })

  it("says reconnecting in one line and opens connection settings", async () => {
    const user = userEvent.setup()
    const onOpenSettings = jest.fn()
    render(
      <MobileChatRuntimeStrip
        gate={gate({
          availability: { state: "offline", reason: "connection-offline" },
          recovery: { kind: "local-settings", section: "companion" },
          connecting: true,
        })}
        onNavigate={jest.fn()}
        onOpenSettings={onOpenSettings}
      />
    )
    const strip = screen.getByTestId("chat-runtime-strip")
    expect(strip).toHaveAttribute("role", "status")
    expect(strip).toHaveAttribute("data-state", "reconnecting")
    expect(strip).toHaveTextContent("strip.connecting")
    expect(strip).toHaveTextContent("strip.cacheOnly")
    const action = screen.getByTestId("chat-runtime-strip-action")
    // The strip's own one-word label, not the card's "Connection settings".
    expect(action).toHaveTextContent(/^strip\.actions\.connectionSettings$/)
    expect(screen.queryByTestId("chat-runtime-strip-queue")).not.toBeInTheDocument()
    await user.click(action)
    expect(onOpenSettings).toHaveBeenCalledWith("companion")
  })

  it("names the gate's state and routes a pairing gap to pairing", async () => {
    const user = userEvent.setup()
    const onNavigate = jest.fn()
    render(<MobileChatRuntimeStrip gate={gate({})} onNavigate={onNavigate} onOpenSettings={jest.fn()} />)
    expect(screen.getByTestId("chat-runtime-strip")).toHaveTextContent("strip.states.requiresPairing")
    expect(screen.getByTestId("chat-runtime-strip-action")).toHaveTextContent(/^strip\.actions\.pair$/)
    await user.click(screen.getByTestId("chat-runtime-strip-action"))
    expect(onNavigate).toHaveBeenCalledWith("/pair?mode=add")
  })

  it("offers no action when there is nowhere to recover to", () => {
    render(
      <MobileChatRuntimeStrip
        gate={gate({
          availability: { state: "unsupported", reason: "operation-unavailable" },
          recovery: { kind: "none" },
        })}
        onNavigate={jest.fn()}
        onOpenSettings={jest.fn()}
      />
    )
    expect(screen.getByTestId("chat-runtime-strip")).toHaveTextContent("strip.states.unsupported")
    expect(screen.queryByTestId("chat-runtime-strip-action")).not.toBeInTheDocument()
  })
})

describe("connection-notice claim", () => {
  it("is held by the card and the strip for as long as either is mounted", () => {
    const card = render(
      <MobileChatRuntimeNotice gate={gate({})} onNavigate={jest.fn()} onOpenSettings={jest.fn()} />
    )
    const strip = render(
      <MobileChatRuntimeStrip gate={gate({})} onNavigate={jest.fn()} onOpenSettings={jest.fn()} />
    )
    expect(isConnectionNoticeClaimed()).toBe(true)
    // Only the strip carries the queue, so only the strip claims it.
    expect(isQueueNoticeClaimed()).toBe(true)
    strip.unmount()
    expect(isConnectionNoticeClaimed()).toBe(true)
    expect(isQueueNoticeClaimed()).toBe(false)
    card.unmount()
    expect(isConnectionNoticeClaimed()).toBe(false)
  })
})
