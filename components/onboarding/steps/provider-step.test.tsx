/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

const standalone = { value: false }
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standalone.value,
}))

const setActiveAccount = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/subscription/core/transport", () => ({
  setActiveAccount: (...a: unknown[]) => setActiveAccount(...a),
}))

const setProviderDefaultAccount = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  setProviderDefaultAccount: (...a: unknown[]) => setProviderDefaultAccount(...a),
}))

const setApiKey = jest.fn().mockResolvedValue(undefined)
const setProviderConfig = jest.fn().mockResolvedValue(undefined)
const setDefaultProvider = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setApiKey, setProviderConfig, setDefaultProvider }),
}))

// The production OAuth dialogs are reused verbatim; stub them so this suite
// exercises the step's own wiring rather than three credential flows. The
// stubs expose the `initialMode` they were handed, which is itself a contract
// here — forcing one defeats the Anthropic dialog's reuse default.
// A function *declaration*: the `jest.mock` factories below run at import time,
// when a `const` would still be in its temporal dead zone.
function dialogStub(name: string) {
  return function Stub({
    open,
    initialMode,
    onAdded,
  }: {
    open: boolean
    initialMode?: string
    onAdded?: (account: unknown) => void
  }) {
    if (!open) return null
    return (
      <div data-testid={`dlg-${name}`} data-initial-mode={initialMode ?? ""}>
        <button
          data-testid={`dlg-${name}-add`}
          onClick={() => onAdded?.(ACCOUNTS[name as keyof typeof ACCOUNTS])}
        />
      </div>
    )
  }
}

const ACCOUNTS = {
  anthropic: {
    id: "acc-a",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    credential: {
      provider: "anthropic",
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: 0,
      mode: "subscription",
      email: "ada@example.com",
      plan: "max",
      storedAtMs: 1,
    },
  },
  codex: {
    id: "acc-c",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    credential: {
      provider: "codex",
      accessToken: "a",
      refreshToken: "r",
      idTokenRaw: "",
      expiresAtMs: 0,
      authMode: "chatgpt",
      email: "ada@example.com",
      chatgptPlanType: "plus",
      storedAtMs: 1,
    },
  },
  opencode: {
    id: "acc-o",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    credential: { provider: "opencode-zen", apiKey: "k", storedAtMs: 1 },
  },
}

jest.mock("@/components/settings/subscription/add-account-dialog/anthropic", () => ({
  AnthropicAddAccountDialog: dialogStub("anthropic"),
}))
jest.mock("@/components/settings/subscription/add-account-dialog/codex", () => ({
  CodexAddAccountDialog: dialogStub("codex"),
}))
jest.mock("@/components/settings/subscription/add-account-dialog/opencode", () => ({
  OpencodeAddAccountDialog: dialogStub("opencode"),
}))

jest.mock("../provider-picker", () => ({
  ProviderPicker: ({ value, onChange }: { value: string; onChange: (id: string) => void }) => (
    <select
      data-testid="onboarding-provider-picker"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {["anthropic", "openai", "ollama", "bedrock"].map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  ),
}))

import { ProviderStep } from "./provider-step"
import { toast } from "sonner"

beforeEach(() => {
  jest.clearAllMocks()
  standalone.value = false
})

describe("ProviderStep", () => {
  it("offers all four sign-in surfaces on a shell that can use the keyring", () => {
    render(<ProviderStep />)
    for (const k of ["claude", "codex", "opencode", "apiKey"]) {
      expect(screen.getByTestId(`onboarding-provider-${k}`)).toBeInTheDocument()
    }
  })

  it("offers only BYOK in standalone mode, where the vault is never read", () => {
    // A browser with no Companion target, or a phone in BYOK mode: chat resolves
    // through `resolveStandaloneProvider` (providerSettings only), so the three
    // subscription cards would have been buttons that configure nothing.
    standalone.value = true
    render(<ProviderStep />)
    expect(screen.getByTestId("onboarding-provider-apiKey")).toBeInTheDocument()
    expect(screen.queryByTestId("onboarding-provider-claude")).toBeNull()
    expect(screen.queryByTestId("onboarding-provider-codex")).toBeNull()
    expect(screen.queryByTestId("onboarding-provider-opencode")).toBeNull()
    // And it stops asking "how do you want to sign in?" about one option.
    expect(screen.getByRole("heading", { name: "provider.byokTitle" })).toBeInTheDocument()
    expect(screen.getByText("provider.byokNote")).toBeInTheDocument()
  })

  it("opens the production OAuth dialog rather than reimplementing the flow", () => {
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-claude"))
    expect(screen.getByTestId("dlg-anthropic")).toBeInTheDocument()
  })

  it("leaves the Anthropic dialog's reuse default alone", () => {
    // Forcing `initialMode="subscription"` overrode `discovered ? "reuse"`,
    // pushing a machine that already has a Claude Code login — the exact
    // machine the scan step celebrates — through a full PKCE round-trip.
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-claude"))
    expect(screen.getByTestId("dlg-anthropic")).toHaveAttribute("data-initial-mode", "")
  })

  it("writes all three pointers a connected subscription needs", async () => {
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-codex"))
    fireEvent.click(screen.getByTestId("dlg-codex-add"))

    await waitFor(() => expect(setActiveAccount).toHaveBeenCalledWith("codex", "acc-c"))
    // ADR-0028's scoped default …
    expect(setProviderDefaultAccount).toHaveBeenCalledWith("codex", "acc-c")
    // … and the one that decides which dispatcher the turn uses at all. Without
    // it `build-options` falls back to the literal "anthropic", so connecting
    // ChatGPT dispatched the first run to Anthropic.
    expect(setDefaultProvider).toHaveBeenCalledWith("codex")
    expect(onConnected).toHaveBeenCalled()
  })

  it("shows what it connected instead of jumping straight on", async () => {
    const onViewChange = jest.fn()
    render(<ProviderStep onViewChange={onViewChange} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-claude"))
    fireEvent.click(screen.getByTestId("dlg-anthropic-add"))

    await waitFor(() =>
      expect(screen.getByTestId("onboarding-provider-connected")).toBeInTheDocument()
    )
    expect(screen.getByTestId("onboarding-provider-email")).toHaveTextContent("ada@example.com")
    expect(screen.getByTestId("onboarding-provider-plan")).toBeInTheDocument()
    expect(onViewChange).toHaveBeenLastCalledWith("connected")
  })

  it("stays on the step when activation fails, instead of claiming success", async () => {
    setActiveAccount.mockRejectedValueOnce(new Error("keyring locked"))
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-claude"))
    fireEvent.click(screen.getByTestId("dlg-anthropic-add"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    expect(onConnected).not.toHaveBeenCalled()
    expect(screen.queryByTestId("onboarding-provider-connected")).toBeNull()
  })

  it("keeps the key form out of the way until it is the chosen method", () => {
    render(<ProviderStep />)
    // Three of the four sign-in methods never touch it, and while it sat under
    // the cards the screen carried two buttons both labelled Continue.
    expect(screen.queryByLabelText("apiKeyLabel")).toBeNull()
  })

  it("swaps to the key panel when the API-key card is chosen, and reports the view", () => {
    const onViewChange = jest.fn()
    render(<ProviderStep onViewChange={onViewChange} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    expect(screen.getByLabelText("apiKeyLabel")).toBeInTheDocument()
    // The chooser is gone, not merely scrolled past.
    expect(screen.queryByTestId("onboarding-provider-claude")).toBeNull()
    // The flow drops its own Continue on this view.
    expect(onViewChange).toHaveBeenCalledWith("apiKey")
  })

  it("goes back to the chooser without losing the step", () => {
    const onViewChange = jest.fn()
    render(<ProviderStep onViewChange={onViewChange} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.click(screen.getByTestId("onboarding-provider-back-to-chooser"))
    expect(screen.getByTestId("onboarding-provider-claude")).toBeInTheDocument()
    expect(onViewChange).toHaveBeenLastCalledWith("chooser")
  })

  it("offers no way back to a chooser that has nothing else in it", () => {
    standalone.value = true
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    expect(screen.queryByTestId("onboarding-provider-back-to-chooser")).toBeNull()
  })

  it("refuses a blank API key instead of advancing", async () => {
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("toastNeedKey"))
    expect(onConnected).not.toHaveBeenCalled()
  })

  it("saves a pasted key where every runtime actually reads it", async () => {
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.change(screen.getByLabelText("apiKeyLabel"), { target: { value: " sk-ant-x " } })
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))

    // `providerSettings.anthropic` is the slot the standalone resolver and the
    // ai-sdk dispatch path read; the legacy `settings.apiKey` is Anthropic-only
    // and invisible to both, so writing only it left a browser user with a key
    // that nothing could use.
    await waitFor(() =>
      expect(setProviderConfig).toHaveBeenCalledWith("anthropic", {
        apiKey: "sk-ant-x",
        enabled: true,
      })
    )
    expect(setDefaultProvider).toHaveBeenCalledWith("anthropic")
    expect(setApiKey).toHaveBeenCalledWith("sk-ant-x")
    expect(onConnected).toHaveBeenCalled()
  })

  it("configures any provider in the catalog, not just Anthropic", async () => {
    // The whole point of B4: a user who pays for OpenAI had no first-run path
    // and had to find Settings → Providers unaided.
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.change(screen.getByTestId("onboarding-provider-picker"), {
      target: { value: "openai" },
    })
    fireEvent.change(screen.getByLabelText("apiKeyLabel"), { target: { value: "sk-openai" } })
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))

    await waitFor(() =>
      expect(setProviderConfig).toHaveBeenCalledWith("openai", {
        apiKey: "sk-openai",
        enabled: true,
      })
    )
    expect(setDefaultProvider).toHaveBeenCalledWith("openai")
    // `settings.apiKey` is an Anthropic-only env slot: pushing an OpenAI key
    // into it would be a silent mix-up.
    expect(setApiKey).not.toHaveBeenCalled()
  })

  it("asks a local server for a base URL instead of a key", async () => {
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.change(screen.getByTestId("onboarding-provider-picker"), {
      target: { value: "ollama" },
    })

    // No key field at all — it needs none — and the well-known port is
    // prefilled, so the form is one field and already correct.
    expect(screen.queryByLabelText("apiKeyLabel")).toBeNull()
    const baseUrl = screen.getByTestId("onboarding-provider-base-url")
    expect(baseUrl).toHaveValue("http://localhost:11434")

    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))
    await waitFor(() =>
      expect(setProviderConfig).toHaveBeenCalledWith("ollama", {
        baseURL: "http://localhost:11434",
        enabled: true,
      })
    )
    expect(setDefaultProvider).toHaveBeenCalledWith("ollama")
  })

  it("refuses to pretend it configured a provider it has no fields for", () => {
    // Amazon Bedrock is "complete" for the shared rules with neither a key nor
    // a base URL — what it actually needs is a region and an access key pair,
    // which only the Settings page asks for. A form with nothing in it and a
    // Save that succeeds would be worse than saying so.
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.change(screen.getByTestId("onboarding-provider-picker"), {
      target: { value: "bedrock" },
    })
    expect(screen.getByTestId("onboarding-provider-needs-settings")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-provider-save-key")).toBeDisabled()
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))
    expect(setProviderConfig).not.toHaveBeenCalled()
  })

  it("does not carry a typed key across a provider switch", () => {
    // A key typed for one provider riding along to another's endpoint is a
    // credential leak to a third party, not a convenience.
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.change(screen.getByLabelText("apiKeyLabel"), { target: { value: "sk-ant-x" } })
    fireEvent.change(screen.getByTestId("onboarding-provider-picker"), {
      target: { value: "openai" },
    })
    expect(screen.getByLabelText("apiKeyLabel")).toHaveValue("")
  })

  it("submits on Enter, so a pasted key does not need a mouse", async () => {
    render(<ProviderStep />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    const input = screen.getByLabelText("apiKeyLabel")
    fireEvent.change(input, { target: { value: "sk-ant-x" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(setDefaultProvider).toHaveBeenCalledWith("anthropic"))
  })

  it("keeps the user on the step when saving the key fails", async () => {
    setProviderConfig.mockRejectedValueOnce(new Error("quota exceeded"))
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-apiKey"))
    fireEvent.change(screen.getByLabelText("apiKeyLabel"), { target: { value: "sk-ant-x" } })
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("quota exceeded"))
    expect(onConnected).not.toHaveBeenCalled()
    // Still on the key panel — the paste is not thrown away.
    expect(screen.getByLabelText("apiKeyLabel")).toBeInTheDocument()
  })
})
