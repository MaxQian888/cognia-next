jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))

import { fireEvent, render, screen, within } from "@testing-library/react"

import type { TokenActionState, TokenFlowState } from "@/hooks/status/use-subscription-actions"
import type { StatusRuntime, SubscriptionPreferences } from "@/lib/status/public-status"
import { openExternal } from "@/lib/tauri/opener"

import { TokenActionDialog } from "./token-action-dialog"

const TOKEN = "k".repeat(40)
const primary: StatusRuntime = {
  mode: "primary",
  apiBase: "/api/status/v1",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: true,
}
const preferences: SubscriptionPreferences = {
  locale: "en",
  componentIds: [],
  maskedEmail: "o•••@example.com",
  revision: 2,
}

function token(
  action: "confirm" | "manage" | "unsubscribe" | null,
  state: TokenFlowState,
  overrides: Partial<TokenActionState> = {}
): TokenActionState {
  return {
    fragment: action ? { kind: "valid", action, token: TOKEN } : { kind: "malformed" },
    dismissed: false,
    state,
    confirm: jest.fn(),
    unsubscribe: jest.fn(),
    savePreferences: jest.fn(),
    dismiss: jest.fn(),
    ...overrides,
  }
}

describe("TokenActionDialog", () => {
  it("renders nothing without a token link", () => {
    render(
      <TokenActionDialog
        runtime={primary}
        token={{ ...token("confirm", { phase: "ready" }), fragment: null }}
      />
    )
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("asks for an explicit confirmation", () => {
    const current = token("confirm", { phase: "ready" })
    render(<TokenActionDialog runtime={primary} token={current} />)
    const dialog = screen.getByRole("dialog", { name: "Confirm your subscription" })
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm subscription" }))
    expect(current.confirm).toHaveBeenCalled()
  })

  it("shows the confirmed preferences", () => {
    render(
      <TokenActionDialog
        runtime={primary}
        token={token("confirm", { phase: "confirmed", preferences })}
      />
    )
    expect(screen.getByTestId("token-done")).toHaveTextContent("Your subscription is confirmed.")
    const summary = screen.getByTestId("token-preferences")
    expect(summary).toHaveTextContent("o•••@example.com")
    expect(summary).toHaveTextContent("English")
    expect(summary).toHaveTextContent("All components")
  })

  it.each([
    ["token_expired", "This link has expired."],
    ["token_used", "already been used"],
    ["token_invalid", "This link is not valid."],
  ] as const)("explains a %s link safely", (kind, text) => {
    render(
      <TokenActionDialog runtime={primary} token={token("confirm", { phase: "error", kind })} />
    )
    expect(screen.getByRole("alert")).toHaveTextContent(text)
  })

  it("explains a malformed link", () => {
    render(<TokenActionDialog runtime={primary} token={token(null, { phase: "ready" })} />)
    const dialog = screen.getByRole("dialog", { name: "Link not recognised" })
    expect(dialog).toHaveTextContent("This link is incomplete or damaged.")
  })

  it("unsubscribes only from the button", () => {
    const current = token("unsubscribe", { phase: "ready" })
    render(<TokenActionDialog runtime={primary} token={current} />)
    expect(current.unsubscribe).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }))
    expect(current.unsubscribe).toHaveBeenCalled()
  })

  it("confirms an unsubscribe", () => {
    render(
      <TokenActionDialog
        runtime={primary}
        token={token("unsubscribe", { phase: "unsubscribed" })}
      />
    )
    expect(screen.getByTestId("token-done")).toHaveTextContent("You are unsubscribed.")
  })

  it("edits preferences for a manage link and reports a conflict", () => {
    const current = token("manage", {
      phase: "preferences",
      preferences,
      notice: "conflict",
      saving: false,
      saveError: null,
    })
    render(<TokenActionDialog runtime={primary} token={current} />)
    expect(screen.getByTestId("token-conflict")).toHaveTextContent("changed elsewhere")
    fireEvent.click(screen.getByRole("checkbox", { name: "Signaling HTTP" }))
    fireEvent.change(screen.getByLabelText("Email language"), { target: { value: "zh-CN" } })
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }))
    expect(current.savePreferences).toHaveBeenCalledWith({
      locale: "zh-CN",
      componentIds: ["signalingHttp"],
    })
  })

  it("announces a saved update", () => {
    render(
      <TokenActionDialog
        runtime={primary}
        token={token("manage", {
          phase: "preferences",
          preferences,
          notice: "saved",
          saving: false,
          saveError: null,
        })}
      />
    )
    expect(screen.getByTestId("token-saved")).toHaveTextContent("Preferences saved.")
  })

  it("announces loading a manage link", () => {
    render(<TokenActionDialog runtime={primary} token={token("manage", { phase: "working" })} />)
    expect(screen.getByRole("status")).toHaveTextContent("Loading your preferences…")
  })

  it("on a mirror links to the primary page with the same fragment instead of posting", () => {
    const current = token("unsubscribe", { phase: "ready" })
    render(
      <TokenActionDialog
        runtime={{ ...primary, mode: "mirror", allowsConsentWrites: false }}
        token={current}
      />
    )
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).toBeNull()
    expect(screen.getByRole("link", { name: "Open on the primary page" })).toHaveAttribute(
      "href",
      `https://status.cognia.cn/status/#action=unsubscribe&token=${TOKEN}`
    )
  })

  it("inside Cognia hands the link to the official page in the browser", () => {
    render(
      <TokenActionDialog
        runtime={{
          ...primary,
          mode: "app",
          apiBase: "https://status.cognia.cn/api/status/v1",
          allowsConsentWrites: false,
        }}
        token={token("confirm", { phase: "ready" })}
      />
    )
    expect(screen.queryByRole("button", { name: "Confirm subscription" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Continue on the status page" }))
    expect(openExternal).toHaveBeenCalledWith(
      `https://status.cognia.cn/status/#action=confirm&token=${TOKEN}`
    )
  })

  it("closes through dismiss", () => {
    const current = token("confirm", { phase: "ready" })
    render(<TokenActionDialog runtime={primary} token={current} />)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(current.dismiss).toHaveBeenCalled()
  })
})
