import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { ProviderKeyOverlay, maskSecret } from "./ProviderKeyOverlay"
import { ThemeProvider } from "../../theme/context"
import { BUILTIN_THEMES } from "../../theme/builtins"

const wrap = (el: React.ReactElement) =>
  render(<ThemeProvider palette={BUILTIN_THEMES.ansi}>{el}</ThemeProvider>)

const baseProps = {
  providerName: "OpenAI",
  credentialKind: "apiKey" as const,
  value: "",
  reveal: false,
  onInput: jest.fn(),
  onToggleReveal: jest.fn(),
  onSubmit: jest.fn(),
  onCancel: jest.fn(),
}

describe("maskSecret", () => {
  it("replaces every character with a bullet, preserving length", () => {
    expect(maskSecret("")).toBe("")
    expect(maskSecret("sk-123")).toBe("••••••")
  })
})

describe("ProviderKeyOverlay", () => {
  beforeEach(() => {
    __resetInk()
    jest.clearAllMocks()
  })

  it("labels the field with the provider name and shows the placeholder when empty", () => {
    const { container } = wrap(<ProviderKeyOverlay {...baseProps} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Add API key for OpenAI")
    expect(text).toContain("paste your OpenAI API key")
  })

  it("masks the typed key by default and reveals it on request", () => {
    const masked = wrap(<ProviderKeyOverlay {...baseProps} value="sk-secret" />)
    expect(masked.container.textContent ?? "").toContain("•••••••••")
    expect(masked.container.textContent ?? "").not.toContain("sk-secret")

    __resetInk()
    const revealed = wrap(<ProviderKeyOverlay {...baseProps} value="sk-secret" reveal />)
    expect(revealed.container.textContent ?? "").toContain("sk-secret")
  })

  it("appends printable input and edits on backspace", () => {
    const onInput = jest.fn()
    wrap(<ProviderKeyOverlay {...baseProps} value="sk-" onInput={onInput} />)
    __fireInput("1", {})
    expect(onInput).toHaveBeenCalledWith("sk-1")
    __fireInput("", { backspace: true })
    expect(onInput).toHaveBeenLastCalledWith("sk")
  })

  it("toggles reveal on Ctrl+R without inserting the character", () => {
    const onInput = jest.fn()
    const onToggleReveal = jest.fn()
    wrap(
      <ProviderKeyOverlay
        {...baseProps}
        value="sk-"
        onInput={onInput}
        onToggleReveal={onToggleReveal}
      />
    )
    __fireInput("r", { ctrl: true })
    // Also honours a shifted Ctrl+R (some terminals report the uppercase letter).
    __fireInput("R", { ctrl: true })
    expect(onToggleReveal).toHaveBeenCalledTimes(2)
    expect(onInput).not.toHaveBeenCalled()
  })

  it("labels existing credentials for management and clears them for replacement", () => {
    const onInput = jest.fn()
    const { container } = wrap(
      <ProviderKeyOverlay {...baseProps} value="sk-existing" existing onInput={onInput} />
    )

    expect(container.textContent ?? "").toContain("Manage API key for OpenAI")
    __fireInput("u", { ctrl: true })
    expect(onInput).toHaveBeenCalledWith("")
  })

  it("submits on Enter and cancels on Escape", () => {
    const onSubmit = jest.fn()
    const onCancel = jest.fn()
    wrap(<ProviderKeyOverlay {...baseProps} onSubmit={onSubmit} onCancel={onCancel} />)
    __fireInput("", { return: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    __fireInput("", { escape: true })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("shows the key-source hint and a validation error when present", () => {
    const { container } = wrap(
      <ProviderKeyOverlay
        {...baseProps}
        keyUrl="https://platform.openai.com/api-keys"
        error="Enter a key, or press Esc to cancel."
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Get one at https://platform.openai.com/api-keys")
    expect(text).toContain("Enter a key, or press Esc to cancel.")
  })

  it("labels a subscription-token field as a token", () => {
    const { container } = wrap(
      <ProviderKeyOverlay {...baseProps} providerName="OpenCode" credentialKind="authToken" />
    )
    expect(container.textContent ?? "").toContain("Add token for OpenCode")
  })

  it("ignores input once inactive", () => {
    const onInput = jest.fn()
    wrap(<ProviderKeyOverlay {...baseProps} onInput={onInput} isActive={false} />)
    __fireInput("x", {})
    expect(onInput).not.toHaveBeenCalled()
  })

  it("does not insert a raw mouse escape sequence into the key", () => {
    const onInput = jest.fn()
    wrap(<ProviderKeyOverlay {...baseProps} value="sk-" onInput={onInput} />)
    // An SGR mouse report that reached the handler as text must be swallowed,
    // never appended to the secret.
    __fireInput("[<0;10;5M", {})
    expect(onInput).not.toHaveBeenCalled()
  })
})
