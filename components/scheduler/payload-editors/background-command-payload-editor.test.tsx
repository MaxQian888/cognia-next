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

  it("survives a payload that is not an object", () => {
    expect(payloadToBackgroundCommandDraft(null)).toEqual(EMPTY_BACKGROUND_COMMAND_DRAFT)
    expect(payloadToBackgroundCommandDraft("nope")).toEqual(EMPTY_BACKGROUND_COMMAND_DRAFT)
  })
})
