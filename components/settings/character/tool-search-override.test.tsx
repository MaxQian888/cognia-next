/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolSearchRuntimeConfig } from "@cognia/agent-config-types"

import { ToolSearchOverride } from "./tool-search-override"

function Harness({
  initial,
  onChange,
}: {
  initial: ToolSearchRuntimeConfig | undefined
  onChange: (next: ToolSearchRuntimeConfig | undefined) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <ToolSearchOverride
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe("ToolSearchOverride", () => {
  it("inherits while unset", () => {
    render(<Harness initial={undefined} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "label" })).toHaveTextContent("inherit")
    expect(screen.queryByLabelText("serversLabel")).not.toBeInTheDocument()
  })

  it("can pin tool search off for this agent", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "disabled" }))
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false })
  })

  it("enables deferral and pins servers and tools", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "enabled" }))
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true })

    const servers = screen.getByLabelText("serversLabel")
    fireEvent.change(servers, { target: { value: "cognia-tools" } })
    fireEvent.keyDown(servers, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      alwaysLoadServers: ["cognia-tools"],
    })

    const tools = screen.getByLabelText("toolsLabel")
    fireEvent.change(tools, { target: { value: "read_file" } })
    fireEvent.keyDown(tools, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      alwaysLoadServers: ["cognia-tools"],
      alwaysLoadTools: ["read_file"],
    })
  })

  it("keeps pins across a disable and clears everything on inherit", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <Harness initial={{ enabled: true, alwaysLoadTools: ["read_file"] }} onChange={onChange} />
    )
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "disabled" }))
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false, alwaysLoadTools: ["read_file"] })

    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "inherit" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
