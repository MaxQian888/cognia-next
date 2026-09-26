/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { InheritBooleanSelect, InheritSelect } from "./inherit-select"

const OPTIONS = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
] as const

describe("InheritSelect", () => {
  it("shows the inherit option while nothing is stored", () => {
    render(
      <InheritSelect
        id="pick"
        label="Pick"
        value={undefined}
        options={OPTIONS}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByRole("combobox", { name: "Pick" })).toHaveTextContent("inherit")
  })

  it("reports the chosen value", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <InheritSelect
        id="pick"
        label="Pick"
        value={undefined}
        options={OPTIONS}
        onChange={onChange}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Pick" }))
    await user.click(screen.getByRole("option", { name: "Option B" }))
    expect(onChange).toHaveBeenCalledWith("b")
  })

  it("reports undefined when switched back to inherit", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <InheritSelect
        id="pick"
        label="Pick"
        value="a"
        options={OPTIONS}
        onChange={onChange}
        inheritLabel="Use the default"
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Pick" }))
    await user.click(screen.getByRole("option", { name: "Use the default" }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("keeps a stored value that is not among the options visible", async () => {
    const user = userEvent.setup()
    render(
      <InheritSelect
        id="pick"
        label="Pick"
        value={"from-a-pack" as "a"}
        options={OPTIONS}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByRole("combobox", { name: "Pick" })).toHaveTextContent("unknownValue")
    await user.click(screen.getByRole("combobox", { name: "Pick" }))
    expect(screen.getByRole("option", { name: "unknownValue" })).toBeInTheDocument()
  })
})

describe("InheritBooleanSelect", () => {
  it.each([
    ["on", true],
    ["off", false],
  ])("maps %s to %s", async (label, expected) => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<InheritBooleanSelect id="flag" label="Flag" value={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "Flag" }))
    await user.click(screen.getByRole("option", { name: label }))
    expect(onChange).toHaveBeenCalledWith(expected)
  })

  it("shows an explicit false as off, not as inherit", () => {
    render(<InheritBooleanSelect id="flag" label="Flag" value={false} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "Flag" })).toHaveTextContent("off")
  })

  it("maps inherit to undefined and honours custom labels", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <InheritBooleanSelect
        id="flag"
        label="Flag"
        value={true}
        onChange={onChange}
        inheritLabel="Default (on)"
        onLabel="Enabled"
        offLabel="Disabled"
      />
    )
    expect(screen.getByRole("combobox", { name: "Flag" })).toHaveTextContent("Enabled")
    await user.click(screen.getByRole("combobox", { name: "Flag" }))
    await user.click(screen.getByRole("option", { name: "Default (on)" }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
