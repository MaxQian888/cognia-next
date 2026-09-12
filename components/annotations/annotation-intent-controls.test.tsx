/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import {
  ANNOTATION_INTENTS,
  ANNOTATION_SEVERITIES,
  AnnotationIntentControls,
} from "./annotation-intent-controls"

function setup(overrides: Partial<Parameters<typeof AnnotationIntentControls>[0]> = {}) {
  const onIntentChange = jest.fn()
  const onSeverityChange = jest.fn()
  render(
    <AnnotationIntentControls
      intent="change"
      severity="suggestion"
      onIntentChange={onIntentChange}
      onSeverityChange={onSeverityChange}
      {...overrides}
    />
  )
  return { onIntentChange, onSeverityChange }
}

describe("AnnotationIntentControls", () => {
  it("offers every intent and severity, in a stable order", () => {
    // Both hosts render from these constants, so the browser rail and the
    // artifact preview cannot drift into offering different vocabularies.
    setup()
    const intent = screen.getByLabelText("intent.label") as HTMLSelectElement
    const severity = screen.getByLabelText("severity.label") as HTMLSelectElement

    expect([...intent.options].map((o) => o.value)).toEqual([...ANNOTATION_INTENTS])
    expect([...severity.options].map((o) => o.value)).toEqual([...ANNOTATION_SEVERITIES])
  })

  it("shows the current values", () => {
    setup({ intent: "fix", severity: "blocking" })
    expect((screen.getByLabelText("intent.label") as HTMLSelectElement).value).toBe("fix")
    expect((screen.getByLabelText("severity.label") as HTMLSelectElement).value).toBe("blocking")
  })

  it("reports a changed intent", () => {
    const { onIntentChange } = setup()
    fireEvent.change(screen.getByLabelText("intent.label"), { target: { value: "question" } })
    expect(onIntentChange).toHaveBeenCalledWith("question")
  })

  it("reports a changed severity", () => {
    const { onSeverityChange } = setup()
    fireEvent.change(screen.getByLabelText("severity.label"), { target: { value: "important" } })
    expect(onSeverityChange).toHaveBeenCalledWith("important")
  })

  it("can be disabled as a unit", () => {
    setup({ disabled: true })
    expect(screen.getByLabelText("intent.label")).toBeDisabled()
    expect(screen.getByLabelText("severity.label")).toBeDisabled()
  })
})

describe("the annotation catalogue is fully translated", () => {
  // `pnpm lint:i18n` cannot see a dynamic key like t(`intent.${value}`), so a
  // vocabulary that grows a member would ship an untranslated option with no
  // gate failing. This asserts the catalogue and the messages agree, in BOTH
  // locales.
  const locales = ["en", "zh-CN"] as const

  it.each(locales)("%s has every intent, severity and status", (locale) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require(`@/i18n/messages/${locale}/annotations.json`)
    for (const intent of ANNOTATION_INTENTS) {
      expect(messages.intent[intent]).toBeTruthy()
    }
    for (const severity of ANNOTATION_SEVERITIES) {
      expect(messages.severity[severity]).toBeTruthy()
    }
    for (const status of ["pending", "acknowledged", "resolved", "dismissed"]) {
      expect(messages.status[status]).toBeTruthy()
    }
    for (const key of ["add", "queued", "remove", "resolve", "send", "sent"]) {
      expect(messages[key]).toBeTruthy()
    }
  })
})
