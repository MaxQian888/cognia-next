/** @jest-environment jsdom */
/**
 * The background-command editor.
 *
 * The type has always been offered in the create form and always fell through
 * to a raw JSON textarea, so what matters here is that the three fields exist
 * and that the required ones actually refuse.
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/settings/common/directory-field", () => ({
  DirectoryField: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <input
      data-testid="cwd-field"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BackgroundCommandPayloadEditor } from "./background-command-payload-editor"
import {
  backgroundCommandDraftToPayload,
  payloadToBackgroundCommandDraft,
  DraftValidationError,
  EMPTY_BACKGROUND_COMMAND_DRAFT,
} from "./types"

it("edits the runtime limit through the draft", async () => {
  const onDraftChange = jest.fn()
  render(
    <BackgroundCommandPayloadEditor
      draft={{ ...EMPTY_BACKGROUND_COMMAND_DRAFT }}
      onDraftChange={onDraftChange}
      testId="bg"
    />
  )
  // One digit: the draft prop is not fed back in here, so a second keystroke
  // would be typed against a still-empty input.
  await userEvent.type(screen.getByTestId("bg-max-runtime"), "5")
  expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxRuntimeMinutes: 5 }))
})

it("clears the limit back to none when the field is emptied", async () => {
  const onDraftChange = jest.fn()
  render(
    <BackgroundCommandPayloadEditor
      draft={{ ...EMPTY_BACKGROUND_COMMAND_DRAFT, maxRuntimeMinutes: 5 }}
      onDraftChange={onDraftChange}
      testId="bg"
    />
  )
  await userEvent.clear(screen.getByTestId("bg-max-runtime"))
  expect(onDraftChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ maxRuntimeMinutes: undefined })
  )
})

it("edits the command through the draft", async () => {
  const onDraftChange = jest.fn()
  render(
    <BackgroundCommandPayloadEditor
      draft={{ ...EMPTY_BACKGROUND_COMMAND_DRAFT }}
      onDraftChange={onDraftChange}
      testId="bg"
    />
  )
  await userEvent.type(screen.getByTestId("bg-command"), "l")
  expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ command: "l" }))
})

describe("converters", () => {
  it("round-trips a payload", () => {
    const payload = { command: "pnpm test", cwd: "/repo", label: "Nightly" }
    expect(backgroundCommandDraftToPayload(payloadToBackgroundCommandDraft(payload))).toEqual(
      payload
    )
  })

  it("refuses an empty command", () => {
    expect(() => backgroundCommandDraftToPayload({ command: "  ", cwd: "/repo" })).toThrow(
      DraftValidationError
    )
  })

  it("refuses a missing working directory", () => {
    // An unattended command resolved against whatever directory the process
    // happened to start in is a different command every time it runs.
    expect(() => backgroundCommandDraftToPayload({ command: "ls", cwd: "" })).toThrow(
      DraftValidationError
    )
  })

  it("drops an empty label rather than storing a blank one", () => {
    expect(backgroundCommandDraftToPayload({ command: "ls", cwd: "/r", label: "  " })).toEqual({
      command: "ls",
      cwd: "/r",
    })
  })

  it("round-trips a runtime limit through minutes", () => {
    const payload = { command: "pnpm build", cwd: "/repo", maxRuntimeMs: 1_800_000 }
    const draft = payloadToBackgroundCommandDraft(payload)
    expect(draft.maxRuntimeMinutes).toBe(30)
    expect(backgroundCommandDraftToPayload(draft)).toEqual(payload)
  })

  // Blank means no limit, which is the shipped behaviour. A persisted 0 would
  // read to anyone opening the JSON as "kill immediately".
  it("omits the limit entirely when the field is left blank", () => {
    expect(backgroundCommandDraftToPayload({ command: "ls", cwd: "/r" })).toEqual({
      command: "ls",
      cwd: "/r",
    })
  })

  it("ignores a non-positive limit on the way in and out", () => {
    expect(
      payloadToBackgroundCommandDraft({ command: "ls", cwd: "/r", maxRuntimeMs: 0 })
        .maxRuntimeMinutes
    ).toBeUndefined()
    expect(
      backgroundCommandDraftToPayload({ command: "ls", cwd: "/r", maxRuntimeMinutes: 0 })
    ).not.toHaveProperty("maxRuntimeMs")
  })

  it("survives a payload that is not an object", () => {
    expect(payloadToBackgroundCommandDraft(null)).toEqual(EMPTY_BACKGROUND_COMMAND_DRAFT)
    expect(payloadToBackgroundCommandDraft("nope")).toEqual(EMPTY_BACKGROUND_COMMAND_DRAFT)
  })
})
