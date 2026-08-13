/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { MessageDisplayCard } from "./message-display-card"

const save = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { messageDisplay: { preset: "focused" } }, save }),
}))

jest.mock("./message-display-controls", () => ({
  MessageDisplayControls: ({
    value,
    onChange,
  }: {
    value: { preset: string }
    onChange: (value: unknown) => void
  }) => (
    <button type="button" onClick={() => onChange({ preset: "inspector" })}>
      {value.preset}
    </button>
  ),
}))

describe("MessageDisplayCard", () => {
  it("persists changes through the shared settings store", () => {
    render(<MessageDisplayCard />)
    fireEvent.click(screen.getByRole("button", { name: "focused" }))
    expect(save).toHaveBeenCalledWith({ messageDisplay: { preset: "inspector" } })
  })
})
