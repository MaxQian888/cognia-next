/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatRuntimeGate } from "@/hooks/chat/use-chat-runtime-gate"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { MobileChatRuntimeNotice } from "./mobile-chat-runtime-notice"

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
