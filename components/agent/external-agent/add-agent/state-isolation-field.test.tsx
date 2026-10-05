/** @jest-environment jsdom */

import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ExternalAgentStateIsolation } from "@/types/agent/external-agent"

import {
  StateIsolationField,
  defaultStateIsolationFor,
  effectiveStateIsolation,
  stateIsolationSupported,
  type StateIsolationFieldProps,
} from "./state-isolation-field"

function Harness(
  props: Partial<StateIsolationFieldProps> & { initial?: ExternalAgentStateIsolation }
) {
  const { initial = "isolated", onChange, ...rest } = props
  const [value, setValue] = useState<ExternalAgentStateIsolation>(initial)
  return (
    <StateIsolationField
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      {...rest}
    />
  )
}

describe("stateIsolationSupported / defaultStateIsolationFor", () => {
  it("follows the runtime's isolation rule", () => {
    expect(stateIsolationSupported("codex-acp")).toBe(true)
    expect(stateIsolationSupported("npx", ["-y", "@zed-industries/claude-code-acp"])).toBe(true)
    expect(stateIsolationSupported("some-unknown-cli")).toBe(false)
    expect(stateIsolationSupported(undefined)).toBe(false)
  })

  it("defaults new configurations to their own state where that can run", () => {
    expect(defaultStateIsolationFor("codex-acp")).toBe("isolated")
    expect(defaultStateIsolationFor("some-unknown-cli")).toBe("shared")
    // A network agent has nothing to isolate; the default changes nothing.
    expect(defaultStateIsolationFor("")).toBe("isolated")
  })
})

describe("effectiveStateIsolation", () => {
  it("keeps the user's choice where it can run and the default otherwise", () => {
    expect(effectiveStateIsolation("shared", "codex-acp")).toBe("shared")
    expect(effectiveStateIsolation(undefined, "codex-acp")).toBe("isolated")
    expect(effectiveStateIsolation(undefined, "some-unknown-cli")).toBe("shared")
  })

  it("never stores own state for a runtime that cannot have one", () => {
    expect(effectiveStateIsolation("isolated", "some-unknown-cli")).toBe("shared")
    expect(effectiveStateIsolation("isolated", "")).toBe("isolated")
  })
})

describe("StateIsolationField", () => {
  it("offers both choices with an explanation and reports the change", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness command="codex-acp" onChange={onChange} />)

    expect(screen.getByText("Agent state")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Own state/ })).toBeChecked()
    expect(
      screen.getByText(/kept apart from this runtime's other configurations/)
    ).toBeInTheDocument()

    await user.click(screen.getByRole("radio", { name: /Shared state/ }))
    expect(onChange).toHaveBeenCalledWith("shared")
    expect(screen.getByRole("radio", { name: /Shared state/ })).toBeChecked()
  })

  it("disables own state, with the reason, for a runtime with no home to isolate", () => {
    render(<Harness command="some-unknown-cli" initial="shared" />)
    expect(screen.getByRole("radio", { name: /Own state/ })).toBeDisabled()
    expect(screen.getByRole("radio", { name: /Shared state/ })).not.toBeDisabled()
    expect(screen.getByTestId("state-isolation-unsupported")).toHaveTextContent(
      "some-unknown-cli has no separate home folder Cognia can isolate"
    )
  })

  it("says a network agent has nothing to isolate", () => {
    render(<Harness />)
    expect(screen.getByTestId("state-isolation-not-applicable")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Own state/ })).not.toBeDisabled()
  })

  it("warns about signing in again only when moving to own state is asked for", async () => {
    const user = userEvent.setup()
    render(<Harness command="codex-acp" initial="shared" showSignInWarning />)
    expect(screen.queryByTestId("state-isolation-sign-in-warning")).toBeNull()
    await user.click(screen.getByRole("radio", { name: /Own state/ }))
    expect(screen.getByTestId("state-isolation-sign-in-warning")).toHaveTextContent(
      "sign in to the agent again"
    )
  })

  it("never warns when the editor did not ask for it", () => {
    render(<Harness command="codex-acp" />)
    expect(screen.queryByTestId("state-isolation-sign-in-warning")).toBeNull()
  })

  it("locks both choices when disabled", () => {
    render(<Harness command="codex-acp" disabled />)
    expect(screen.getByRole("radio", { name: /Own state/ })).toBeDisabled()
    expect(screen.getByRole("radio", { name: /Shared state/ })).toBeDisabled()
  })
})
