/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { ErrorHandlingSection } from "./error-handling-section"
import type { WorkflowNodeErrorHandling } from "@/types/workflow/visual"

function wrap(
  errorHandling: WorkflowNodeErrorHandling | undefined,
  onChange: (next: WorkflowNodeErrorHandling | undefined) => void = jest.fn()
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ErrorHandlingSection errorHandling={errorHandling} onChange={onChange} />
    </NextIntlClientProvider>
  )
}

async function open() {
  await userEvent.click(screen.getByText("Error handling"))
}

describe("ErrorHandlingSection", () => {
  it("starts collapsed without config and shows the badge when configured", () => {
    wrap(undefined)
    expect(screen.queryByLabelText("On error")).toBeNull()
    expect(screen.queryByText("On")).toBeNull()
  })

  it("selects an onError mode (Radix select via keyboard)", async () => {
    const onChange = jest.fn()
    wrap(undefined, onChange)
    await open()
    await userEvent.click(screen.getByLabelText("On error"))
    await userEvent.click(screen.getByRole("option", { name: "Continue with error output" }))
    expect(onChange).toHaveBeenCalledWith({ onError: "continue" })
  })

  it("normalizes an all-defaults config back to undefined", async () => {
    const onChange = jest.fn()
    wrap({ onError: "continue" }, onChange)
    await userEvent.click(screen.getByLabelText("On error"))
    await userEvent.click(screen.getByRole("option", { name: "Fail (workflow policy)" }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("shows the error-branch hint for errorBranch mode", () => {
    wrap({ onError: "errorBranch" })
    expect(screen.getByText(/red error handle/)).toBeInTheDocument()
  })

  it("commits only valid JSON for the default value", () => {
    const onChange = jest.fn()
    wrap({ onError: "defaultValue" }, onChange)
    const textarea = screen.getByLabelText("Default value (JSON)")

    fireEvent.change(textarea, { target: { value: "{ not json" } })
    expect(screen.getByTestId("eh-json-error")).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(textarea, { target: { value: '{"x": 1}' } })
    expect(onChange).toHaveBeenCalledWith({ onError: "defaultValue", defaultValue: { x: 1 } })
  })

  it("toggles the retry override on with sane defaults and edits fields", () => {
    const onChange = jest.fn()
    wrap({ onError: "continue" }, onChange)
    fireEvent.click(screen.getByRole("switch", { name: "Override retries" }))
    expect(onChange).toHaveBeenCalledWith({
      onError: "continue",
      retry: { maxRetries: 0, retryIntervalMs: 1000, backoff: "exponential" },
    })
  })

  it("edits retry numbers and clears the override", () => {
    const onChange = jest.fn()
    wrap({ retry: { maxRetries: 1, retryIntervalMs: 1000, backoff: "exponential" } }, onChange)
    fireEvent.change(screen.getByLabelText("Retries"), { target: { value: "3" } })
    expect(onChange).toHaveBeenCalledWith({
      retry: { maxRetries: 3, retryIntervalMs: 1000, backoff: "exponential" },
    })

    fireEvent.click(screen.getByRole("switch", { name: "Override retries" }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("toggles the circuit breaker on with defaults and edits the threshold", () => {
    const onChange = jest.fn()
    wrap({ onError: "continue" }, onChange)
    fireEvent.click(screen.getByRole("switch", { name: "Circuit breaker" }))
    expect(onChange).toHaveBeenCalledWith({
      onError: "continue",
      circuitBreaker: { threshold: 5, cooldownMs: 60_000 },
    })

    onChange.mockClear()
    wrap({ circuitBreaker: { threshold: 5, cooldownMs: 60_000 } }, onChange)
    fireEvent.change(screen.getByLabelText("Failure threshold"), { target: { value: "2" } })
    expect(onChange).toHaveBeenCalledWith({ circuitBreaker: { threshold: 2, cooldownMs: 60_000 } })
  })

  it("shows the max-interval field only for exponential backoff", () => {
    const { rerender } = wrap({
      retry: { maxRetries: 1, retryIntervalMs: 500, backoff: "exponential" },
    })
    expect(screen.getByLabelText("Max interval (ms)")).toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ErrorHandlingSection
          errorHandling={{ retry: { maxRetries: 1, retryIntervalMs: 500, backoff: "fixed" } }}
          onChange={jest.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByLabelText("Max interval (ms)")).toBeNull()
  })
})
