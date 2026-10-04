import { render, screen } from "@testing-library/react"

import type { DeviceNotApplicable } from "@/lib/devices/section-plan"

import { NotApplicableSection } from "./not-applicable-section"

const SSH_ENTRIES: DeviceNotApplicable[] = [
  {
    id: "capabilities",
    labelKey: "capabilities.title",
    reasonKey: "capabilities.noVocabulary.ssh-host",
  },
  { id: "access", labelKey: "access.title", reasonKey: "access.notApplicable.ssh-host" },
  { id: "runtime", labelKey: "notApplicable.runtime", reasonKey: "runtime.reason.sshShellOnly" },
  {
    id: "dispatch",
    labelKey: "activity.dispatch",
    reasonKey: "activity.dispatchNotAddressable",
  },
  { id: "placement", labelKey: "activity.placement", reasonKey: "activity.providesNothing" },
]

describe("NotApplicableSection", () => {
  /**
   * Every row is the sentence the card it replaces would have rendered, so
   * nothing a reader could learn before is lost.
   */
  it("states each answer in the words its card used, under the card's own title", () => {
    render(<NotApplicableSection kind="ssh-host" entries={SSH_ENTRIES} wide />)
    expect(screen.getByText("Capabilities")).toBeInTheDocument()
    expect(screen.getByTestId("not-applicable-runtime")).toHaveTextContent(
      "SSH gives a shell and nothing else, so there is no workspace or sandbox to report."
    )
    expect(screen.getByTestId("not-applicable-dispatch")).toHaveTextContent(
      "This device is not addressed by the dispatch queue."
    )
  })

  it("explains, per kind, what the record is", () => {
    render(
      <NotApplicableSection
        kind="paired-device"
        entries={[
          {
            id: "sandbox",
            labelKey: "runtime.sandbox",
            reasonKey: "runtime.reason.sandboxNotHosted",
          },
        ]}
        wide={false}
      />
    )
    expect(screen.getByText("Does not apply here")).toBeInTheDocument()
    expect(screen.getByText(/why a paired device has no answer/)).toBeInTheDocument()
  })

  it("carries the anchor the jump strip lands on, and its width hint", () => {
    const { rerender } = render(<NotApplicableSection kind="ssh-host" entries={SSH_ENTRIES} wide />)
    const card = screen.getByTestId("device-section-not-applicable")
    expect(card).toHaveAttribute("id", "device-section-not-applicable")
    expect(card.className).toContain("@3xl/device-pane:col-span-2")

    rerender(<NotApplicableSection kind="ssh-host" entries={SSH_ENTRIES} wide={false} />)
    expect(screen.getByTestId("device-section-not-applicable").className).not.toContain(
      "col-span-2"
    )
  })

  it("renders nothing when everything applies", () => {
    const { container } = render(<NotApplicableSection kind="local" entries={[]} wide={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
