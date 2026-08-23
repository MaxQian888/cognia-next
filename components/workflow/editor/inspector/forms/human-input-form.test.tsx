/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { HumanInputField } from "@/types/workflow/human-input"
import { HumanInputRequestConfig } from "./human-input-form"

function wrap(params: Record<string, unknown>, onChange = jest.fn()) {
  return {
    onChange,
    ...render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <HumanInputRequestConfig params={params} onChange={onChange} />
      </NextIntlClientProvider>
    ),
  }
}

function lastParams(onChange: jest.Mock): Record<string, unknown> {
  return onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

describe("HumanInputRequestConfig", () => {
  it("authors fields, actions, and assignees with structured controls", () => {
    const fields = wrap({ fields: [], actions: [], assignees: [] })
    fireEvent.click(screen.getByRole("button", { name: "Add field" }))
    expect(lastParams(fields.onChange).fields).toEqual([
      { id: "field_1", type: "short-text", label: "Response" },
    ])
    fields.unmount()

    const actions = wrap({ fields: [], actions: [], assignees: [] })
    fireEvent.click(screen.getByRole("button", { name: "Add action" }))
    expect(lastParams(actions.onChange).actions).toEqual([
      { id: "action_1", label: "Submit", tone: "primary" },
    ])
    actions.unmount()

    const assignees = wrap({ fields: [], actions: [], assignees: [] })
    fireEvent.click(screen.getByRole("button", { name: "Add assignee" }))
    expect(lastParams(assignees.onChange).assignees).toEqual([{ kind: "member", id: "" }])
  })

  it("edits select options and sensitive-field metadata without raw JSON", () => {
    const field: HumanInputField = {
      id: "priority",
      type: "single-select",
      label: "Priority",
      options: [{ value: "low", label: "Low" }],
    }
    const { onChange, rerender } = wrap({
      fields: [field],
      actions: [{ id: "submit", label: "Submit" }],
      assignees: [{ kind: "initiator" }],
      completionPolicy: { mode: "any" },
    })

    fireEvent.change(screen.getByLabelText("Options"), { target: { value: "low, high" } })
    expect((lastParams(onChange).fields as HumanInputField[])[0].options).toEqual([
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ])

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <HumanInputRequestConfig
          params={{ fields: [field], actions: [], assignees: [] }}
          onChange={onChange}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("switch", { name: "Sensitive" }))
    expect((lastParams(onChange).fields as HumanInputField[])[0].sensitive).toBe(true)
  })

  it("authors timeout and quorum bounds as numbers", () => {
    const { onChange } = wrap({
      fields: [],
      actions: [],
      assignees: [],
      completionPolicy: { mode: "quorum", count: 2 },
    })
    fireEvent.change(screen.getByLabelText("Required responses"), { target: { value: "3" } })
    expect(lastParams(onChange).completionPolicy).toEqual({ mode: "quorum", count: 3 })
    fireEvent.change(screen.getByLabelText("Timeout (ms)"), { target: { value: "60000" } })
    expect(lastParams(onChange).timeoutMs).toBe(60_000)
    fireEvent.change(screen.getByLabelText("Sensitive value retention (days)"), {
      target: { value: "7" },
    })
    expect(lastParams(onChange).sensitiveRetentionDays).toBe(7)
  })
})
