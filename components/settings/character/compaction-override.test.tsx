/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SessionCompressionOverrides } from "@cognia/agent-config-types/compression"

import { CompactionOverride, parseBoundedInteger } from "./compaction-override"

/** Blur commits through an async draft; settle it inside act. */
async function commitBlur(element: HTMLElement) {
  await act(async () => {
    fireEvent.blur(element)
  })
}

function Harness({
  initial,
  onChange,
}: {
  initial: SessionCompressionOverrides | undefined
  onChange: (next: SessionCompressionOverrides | undefined) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <CompactionOverride
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe("parseBoundedInteger", () => {
  it("treats empty text as inherit and clamps numbers into range", () => {
    expect(parseBoundedInteger("", 10, 99)).toBeUndefined()
    expect(parseBoundedInteger("  ", 10, 99)).toBeUndefined()
    expect(parseBoundedInteger("5", 10, 99)).toBe(10)
    expect(parseBoundedInteger("150", 10, 99)).toBe(99)
    expect(parseBoundedInteger("42.6", 10, 99)).toBe(43)
  })
})

describe("CompactionOverride", () => {
  it("shows every field as inherited while nothing is set", () => {
    render(<Harness initial={undefined} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "enabled.heading" })).toHaveTextContent("inherit")
    expect(screen.getByRole("combobox", { name: "algorithm.heading" })).toHaveTextContent("inherit")
    expect(screen.getByRole("combobox", { name: "trigger.heading" })).toHaveTextContent("inherit")
    expect(screen.getByLabelText("threshold.label")).toHaveValue(null)
  })

  it("overrides one field at a time", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "algorithm.heading" }))
    await user.click(screen.getByRole("option", { name: "algorithm.options.hybrid" }))
    expect(onChange).toHaveBeenLastCalledWith({ compressionStrategy: "hybrid" })

    await user.click(screen.getByRole("combobox", { name: "enabled.heading" }))
    await user.click(screen.getByRole("option", { name: "off" }))
    expect(onChange).toHaveBeenLastCalledWith({
      compressionStrategy: "hybrid",
      compressionEnabled: false,
    })
  })

  it("commits a number on blur and clears it when emptied", async () => {
    const onChange = jest.fn()
    render(<Harness initial={{ tokenThreshold: 80 }} onChange={onChange} />)
    const input = screen.getByLabelText("keepRecent.label")
    fireEvent.change(input, { target: { value: "12" } })
    await commitBlur(input)
    expect(onChange).toHaveBeenLastCalledWith({ tokenThreshold: 80, preserveRecentMessages: 12 })

    const threshold = screen.getByLabelText("threshold.label")
    expect(threshold).toHaveValue(80)
    fireEvent.change(threshold, { target: { value: "" } })
    await commitBlur(threshold)
    expect(onChange).toHaveBeenLastCalledWith({ preserveRecentMessages: 12 })
  })

  it("writes undefined, not an empty object, once the last field inherits again", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={{ compressionTrigger: "manual" }} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "trigger.heading" }))
    await user.click(screen.getByRole("option", { name: "inherit" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
