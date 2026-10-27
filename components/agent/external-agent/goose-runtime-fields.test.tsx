/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { GooseRuntimeFields } from "./goose-runtime-fields"

it("sets a positive parent limit while preserving unrelated environment values", () => {
  const onRowsChange = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <GooseRuntimeFields
        rows={[{ key: "GOOSE_MODEL", value: "model" }]}
        onRowsChange={onRowsChange}
        args="acp --with-builtin developer"
        onArgsChange={jest.fn()}
      />
    </NextIntlClientProvider>
  )
  const input = screen.getByRole("spinbutton", { name: en.externalAgent.goose.concurrency })
  fireEvent.change(input, { target: { value: "0" } })
  expect(onRowsChange).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: "2" } })
  expect(onRowsChange).toHaveBeenCalledWith([
    { key: "GOOSE_MODEL", value: "model" },
    { key: "GOOSE_MAX_CONCURRENT_SUBAGENTS", value: "2" },
  ])
})

it("opts into code_execution without losing developer or other CLI arguments", async () => {
  const onArgsChange = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <GooseRuntimeFields
        rows={[]}
        onRowsChange={jest.fn()}
        args="acp --with-builtin developer --enable-scheduler"
        onArgsChange={onArgsChange}
      />
    </NextIntlClientProvider>
  )
  await userEvent
    .setup()
    .click(screen.getByRole("switch", { name: en.externalAgent.goose.codeMode }))
  expect(onArgsChange).toHaveBeenCalledWith(
    "acp --enable-scheduler --with-builtin developer,code_execution"
  )
})
