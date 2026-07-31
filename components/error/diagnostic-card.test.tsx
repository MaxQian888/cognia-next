/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { createDiagnostic } from "@cognia/diagnostics"

import { DiagnosticCard, InlineError } from "./diagnostic-card"

const diag = (code: Parameters<typeof createDiagnostic>[0], init = {}) =>
  createDiagnostic(code, { source: "chat", now: () => 0, id: "d1", ...init })

describe("DiagnosticCard", () => {
  it("labels the failure from the code, not from its raw text", () => {
    // The raw text here is deliberately unclassifiable, so the only source the
    // label and hint could have come from is the code.
    render(
      <DiagnosticCard diagnostic={diag("connectionRefused", { message: "upstream said <nope>" })} />
    )
    expect(screen.getByText("Connection refused")).toBeInTheDocument()
    expect(screen.getByText(/server isn't accepting connections/i)).toBeInTheDocument()
    expect(screen.getByText("upstream said <nope>")).toBeInTheDocument()
  })

  it("exposes the code and severity for styling and assertions", () => {
    render(<DiagnosticCard diagnostic={diag("rateLimited")} />)
    const card = screen.getByTestId("diagnostic-card")
    expect(card).toHaveAttribute("data-code", "rateLimited")
    expect(card).toHaveAttribute("data-severity", "warning")
  })

  it("renders only the actions the caller can actually service", () => {
    // `unauthorized` offers open-settings + reauth; with a handler for just one,
    // the other must not render as a dead button.
    const onOpenSettings = jest.fn()
    render(
      <DiagnosticCard
        diagnostic={diag("unauthorized")}
        handlers={{ "open-settings": onOpenSettings }}
      />
    )
    expect(screen.getByTestId("diagnostic-action-open-settings")).toBeInTheDocument()
    expect(screen.queryByTestId("diagnostic-action-reauth")).not.toBeInTheDocument()
  })

  it("passes the whole action to the handler so its payload survives", () => {
    const onOpenSettings = jest.fn()
    render(
      <DiagnosticCard
        diagnostic={diag("unauthorized")}
        handlers={{ "open-settings": onOpenSettings }}
      />
    )
    fireEvent.click(screen.getByTestId("diagnostic-action-open-settings"))
    expect(onOpenSettings).toHaveBeenCalledWith({ kind: "open-settings", section: "providers" })
  })

  it("offers the settings shortcut from the code, with no regex on the message", () => {
    // The old card ran /api[\s_-]?key/i over English prose to decide this, so
    // the button never appeared for a non-English provider message.
    const onOpenSettings = jest.fn()
    render(
      <DiagnosticCard
        diagnostic={diag("unauthorized", { message: "认证失败：API 密钥无效" })}
        handlers={{ "open-settings": onOpenSettings }}
      />
    )
    expect(screen.getByTestId("diagnostic-action-open-settings")).toBeInTheDocument()
  })

  it("renders a countdown label when the provider stated a delay", () => {
    render(
      <DiagnosticCard
        diagnostic={diag("rateLimited", { meta: { retryAfterMs: 30_000 } })}
        handlers={{ "wait-and-retry": jest.fn() }}
      />
    )
    expect(screen.getByTestId("diagnostic-action-wait-and-retry")).toHaveTextContent("30 seconds")
  })

  it("renders external-agent recovery hints from their key ids", () => {
    render(
      <DiagnosticCard
        diagnostic={diag("protocolUnsupported")}
        recoveryHintKeys={["switchToAcp", "resaveConfiguration"]}
      />
    )
    expect(screen.getByText(/Switch the agent's protocol to ACP/)).toBeInTheDocument()
    expect(screen.getByText(/Save the agent's configuration again/)).toBeInTheDocument()
  })

  it("falls back to the raw hint id when a key has no translation", () => {
    render(
      <DiagnosticCard diagnostic={diag("unknown")} recoveryHintKeys={["notATranslatedHint"]} />
    )
    expect(screen.getByText("notATranslatedHint")).toBeInTheDocument()
  })

  it("falls back to the raw code when a producer is ahead of the vocabulary", () => {
    const unknownCode = { ...diag("unknown"), code: "somethingBrandNew" as never }
    render(<DiagnosticCard diagnostic={unknownCode} />)
    expect(screen.getByText("somethingBrandNew")).toBeInTheDocument()
  })

  it("omits the footer entirely when nothing is actionable", () => {
    render(<DiagnosticCard diagnostic={diag("contentPolicy")} />)
    expect(screen.queryByTestId("diagnostic-card-dismiss")).not.toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("invokes onDismiss", () => {
    const onDismiss = jest.fn()
    render(<DiagnosticCard diagnostic={diag("timeout")} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId("diagnostic-card-dismiss"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("still parses the raw message so its stack stays navigable", () => {
    render(
      <DiagnosticCard
        diagnostic={diag("unknown", { message: "connect ECONNREFUSED 1.2.3.4:80" })}
      />
    )
    // Category badge from the parser, inside the card's detail area.
    expect(screen.getByText("Connection refused")).toBeInTheDocument()
  })
})

describe("InlineError (deprecated string shim)", () => {
  it("renders the error message and the failure title", () => {
    render(<InlineError message="something went wrong" />)
    expect(screen.getByText("Failed to send")).toBeInTheDocument()
    expect(screen.getByText("something went wrong")).toBeInTheDocument()
  })

  it("parses a network error into a category badge with a hint", () => {
    render(<InlineError message="connect ECONNREFUSED 127.0.0.1:5173" />)
    expect(screen.getByText("Connection refused")).toBeInTheDocument()
    expect(screen.getByText(/server isn't accepting connections/i)).toBeInTheDocument()
  })

  it("invokes onRetry when the retry button is clicked", () => {
    const onRetry = jest.fn()
    render(<InlineError message="boom" onRetry={onRetry} />)
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("shows the settings shortcut whenever the caller supplies one", () => {
    const onOpenSettings = jest.fn()
    render(<InlineError message="Invalid API key provided" onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("invokes onDismiss when dismissed", () => {
    const onDismiss = jest.fn()
    render(<InlineError message="boom" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("renders no footer when the caller wired no callbacks", () => {
    render(<InlineError message="boom" />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
