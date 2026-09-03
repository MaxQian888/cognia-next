/** @jest-environment jsdom */
/**
 * The shared character selector.
 *
 * Two behaviours are worth pinning. The picker must exist at all in the goal
 * editor, which previously asked for an opaque id through a text input. And a
 * stored id the list no longer contains must READ as something, rather than
 * rendering an empty trigger that looks like "nothing selected" for a task
 * that is in fact bound to a deleted character.
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn() }))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CharacterPicker } from "./character-picker"

const CHARACTERS = [
  { id: "c1", name: "Researcher" },
  { id: "c2", name: "Editor" },
] as never

it("offers the user's characters by name", async () => {
  const onChange = jest.fn()
  render(
    <CharacterPicker
      value={undefined}
      onChange={onChange}
      testId="goal"
      charactersForTesting={CHARACTERS}
    />
  )

  await userEvent.click(screen.getByTestId("goal-character-select"))
  await userEvent.click(await screen.findByText("Researcher"))
  expect(onChange).toHaveBeenCalledWith("c1")
})

it("reports the none option as undefined, not an empty string", async () => {
  const onChange = jest.fn()
  render(
    <CharacterPicker
      value="c1"
      onChange={onChange}
      testId="goal"
      charactersForTesting={CHARACTERS}
    />
  )

  await userEvent.click(screen.getByTestId("goal-character-select"))
  await userEvent.click(await screen.findByText("payload.characterNone"))
  // The payload field is optional, and `""` is not the same as absent to the
  // executor that reads it.
  expect(onChange).toHaveBeenCalledWith(undefined)
})

it("names a character that has since been deleted instead of showing an empty trigger", () => {
  render(
    <CharacterPicker
      value="c-gone"
      onChange={jest.fn()}
      testId="goal"
      charactersForTesting={CHARACTERS}
    />
  )
  // Radix renders an EMPTY trigger for a value outside its item list, which
  // reads as "nothing selected" for a task that is in fact still bound.
  expect(screen.getByTestId("goal-character-select")).toHaveTextContent("characterMissing")
})
