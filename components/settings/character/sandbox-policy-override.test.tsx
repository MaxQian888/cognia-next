/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The shared fields module also exports the app-level card, which saves
// through the settings db; the override never calls it.
jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn() }))

import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SandboxResourcePolicy } from "@cognia/agent-config-types"

import { SandboxPolicyOverride } from "./sandbox-policy-override"

function Harness({
  initial,
  onChange,
}: {
  initial: SandboxResourcePolicy | undefined
  onChange: (next: SandboxResourcePolicy | undefined) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <SandboxPolicyOverride
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe("SandboxPolicyOverride", () => {
  it("inherits while unset and hides the shared fields", () => {
    render(<Harness initial={undefined} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "label" })).toHaveTextContent("inherit")
    expect(screen.queryByTestId("agent-sandbox-policy-cpu")).not.toBeInTheDocument()
  })

  it("takes the ceiling over with an empty policy and edits it with the shared fields", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "override" }))
    expect(onChange).toHaveBeenLastCalledWith({})

    fireEvent.change(screen.getByTestId("agent-sandbox-policy-cpu"), { target: { value: "30" } })
    expect(onChange).toHaveBeenLastCalledWith({ maxCpuSeconds: 30 })
  })

  it("returns to inherit with undefined", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={{ network: "off" }} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "inherit" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
