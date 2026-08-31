import { render, screen } from "@testing-library/react"

import en from "@/i18n/messages/en/devices.json"

import { ShellOnlySection } from "./shell-only-section"

/**
 * The card exists to merge five answers into one, so what is worth pinning is
 * that it did not paraphrase on the way. Every sentence has to be the same
 * string the section it stands in for would have rendered. A hand-written
 * summary here would drift from the real answer the day either one is edited.
 */
describe("ShellOnlySection", () => {
  it("carries the exact sentences the five sections it replaces would have shown", () => {
    render(<ShellOnlySection />)
    const card = screen.getByTestId("device-section-shell-only")
    for (const sentence of [
      en.capabilities.noVocabulary["ssh-host"],
      en.access.notApplicable["ssh-host"],
      en.runtime.reason.sshShellOnly,
      en.activity.dispatchNotAddressable,
      en.activity.providesNothing,
    ]) {
      expect(card).toHaveTextContent(sentence)
    }
  })

  /**
   * Labelled with the section names the reader would otherwise have gone
   * looking for. A list of five loose sentences would not say which question
   * each one closes.
   */
  it("labels each answer with the section that would have asked it", () => {
    render(<ShellOnlySection />)
    const card = screen.getByTestId("device-section-shell-only")
    for (const label of [
      en.capabilities.title,
      en.access.title,
      en.shellOnly.runtime,
      en.activity.dispatch,
      en.activity.placement,
    ]) {
      expect(card).toHaveTextContent(label)
    }
  })

  /**
   * Full width because it is a record of five rows. Half a pane seats one
   * column of them, which is the tall thin card this change exists to stop
   * producing.
   */
  it("spans the pane rather than taking a column", () => {
    render(<ShellOnlySection />)
    expect(screen.getByTestId("device-section-shell-only").className).toContain(
      "@3xl/device-pane:col-span-2"
    )
  })
})
