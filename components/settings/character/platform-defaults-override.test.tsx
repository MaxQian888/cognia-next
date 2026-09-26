/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CharacterPlatformDefaults } from "@/types/connectors/binding"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

import {
  composePlatformDefaults,
  pickTriggerParts,
  PlatformDefaultsOverride,
} from "./platform-defaults-override"

function Harness({
  initial,
  onChange,
}: {
  initial: CharacterPlatformDefaults | undefined
  onChange: (next: CharacterPlatformDefaults | undefined) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <PlatformDefaultsOverride
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe("platform defaults helpers", () => {
  it("drops unset pieces and collapses an empty result to undefined", () => {
    expect(composePlatformDefaults(undefined, { mode: "draft" })).toEqual({ mode: "draft" })
    expect(composePlatformDefaults({ mode: "draft" }, { mode: undefined })).toBeUndefined()
    expect(composePlatformDefaults({ mode: "auto" }, { trigger: undefined })).toEqual({
      mode: "auto",
    })
  })

  it("keeps only the trigger parts that are taken over", () => {
    const policy = defaultPrivateChatPolicy()
    expect(pickTriggerParts(policy, { rules: false, blockers: false, storeUnmatched: false })).toBe(
      undefined
    )
    expect(
      pickTriggerParts(policy, { rules: false, blockers: true, storeUnmatched: false })
    ).toEqual({ blockers: policy.blockers })
  })
})

describe("PlatformDefaultsOverride", () => {
  it("inherits the bot's mode and trigger while unset", () => {
    render(<Harness initial={undefined} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "mode.label" })).toHaveTextContent("mode.inherit")
    expect(screen.getByRole("switch", { name: "parts.rules" })).not.toBeChecked()
    expect(screen.queryByTestId("agent-platform-trigger-policy-editor")).not.toBeInTheDocument()
  })

  it("sets and clears the recommended mode", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "mode.label" }))
    await user.click(screen.getByRole("option", { name: "mode.draft" }))
    expect(onChange).toHaveBeenLastCalledWith({ mode: "draft" })

    await user.click(screen.getByRole("combobox", { name: "mode.label" }))
    await user.click(screen.getByRole("option", { name: "mode.inherit" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it("takes the conditions over from the private-chat profile and edits them", () => {
    const onChange = jest.fn()
    render(<Harness initial={{ mode: "auto" }} onChange={onChange} />)
    fireEvent.click(screen.getByRole("switch", { name: "parts.rules" }))
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "auto",
      trigger: { rules: defaultPrivateChatPolicy().rules },
    })

    // The shared editor now shows the conditions; switching one off narrows them.
    fireEvent.click(screen.getByTestId("agent-platform-trigger-rule-private-default-switch"))
    const last = onChange.mock.calls.at(-1)?.[0] as CharacterPlatformDefaults
    expect(last.mode).toBe("auto")
    expect(last.trigger?.rules?.some((rule) => rule.kind === "private-default")).toBe(false)
    expect(last.trigger?.blockers).toBeUndefined()
  })

  it("releases the last taken-over part back to inherit", () => {
    const onChange = jest.fn()
    render(
      <Harness initial={{ trigger: { storeUnmatchedInDraftMode: true } }} onChange={onChange} />
    )
    expect(screen.getByRole("switch", { name: "parts.storeUnmatched" })).toBeChecked()
    fireEvent.click(screen.getByRole("switch", { name: "parts.storeUnmatched" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
