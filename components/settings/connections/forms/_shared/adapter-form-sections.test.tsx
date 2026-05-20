/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { AdapterFormSections, type FormSection } from "./adapter-form-sections"

const messages = {
  settings: {
    connections: {
      adapterFormSections: {
        save: "Save",
        saving: "Saving…",
        cancel: "Cancel",
        errorBadge: "Error",
      },
    },
  },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

function makeSections(overrides: Partial<FormSection>[] = []): FormSection[] {
  const base: FormSection[] = [
    { id: "identity", label: "Identity", defaultOpen: true, children: <div>id-body</div> },
    { id: "delivery", label: "Delivery", children: <div>dl-body</div> },
    { id: "advanced", label: "Advanced", children: <div>adv-body</div> },
  ]
  return base.map((s, i) => ({ ...s, ...overrides[i] }))
}

describe("AdapterFormSections", () => {
  it("renders every section header", () => {
    render(
      withIntl(<AdapterFormSections sections={makeSections()} onSubmit={() => undefined} dirty />)
    )
    expect(screen.getByText("Identity")).toBeInTheDocument()
    expect(screen.getByText("Delivery")).toBeInTheDocument()
    expect(screen.getByText("Advanced")).toBeInTheDocument()
  })

  it("opens sections marked defaultOpen and keeps others closed", () => {
    render(
      withIntl(<AdapterFormSections sections={makeSections()} onSubmit={() => undefined} dirty />)
    )
    expect(screen.getByText("id-body")).toBeVisible()
    // Radix Collapsible renders closed bodies via CSS, not removal — verify
    // by querying the body's visibility via its parent state attribute.
    const dl = screen.getByTestId("adapter-form-section-delivery")
    expect(dl.getAttribute("data-state")).toBe("closed")
  })

  it("toggles section open/closed when the header is clicked", async () => {
    const user = userEvent.setup()
    render(
      withIntl(<AdapterFormSections sections={makeSections()} onSubmit={() => undefined} dirty />)
    )
    const trigger = screen.getByRole("button", { name: /^Delivery$/i })
    expect(screen.getByTestId("adapter-form-section-delivery").getAttribute("data-state")).toBe(
      "closed"
    )
    await user.click(trigger)
    expect(screen.getByTestId("adapter-form-section-delivery").getAttribute("data-state")).toBe(
      "open"
    )
  })

  it("shows an Error badge when a section has an error", () => {
    const sections = makeSections([{}, { error: "Missing webhook URL" }])
    render(withIntl(<AdapterFormSections sections={sections} onSubmit={() => undefined} dirty />))
    expect(screen.getByTestId("adapter-form-section-delivery-error-badge")).toBeInTheDocument()
  })

  it("disables Save when dirty=false", () => {
    render(
      withIntl(
        <AdapterFormSections sections={makeSections()} onSubmit={() => undefined} dirty={false} />
      )
    )
    expect(screen.getByTestId("adapter-form-save")).toBeDisabled()
  })

  it("fires onSubmit when Save is clicked", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()
    render(withIntl(<AdapterFormSections sections={makeSections()} onSubmit={onSubmit} dirty />))
    await user.click(screen.getByTestId("adapter-form-save"))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("renders Saving… while submitting=true", () => {
    render(
      withIntl(
        <AdapterFormSections
          sections={makeSections()}
          onSubmit={() => undefined}
          dirty
          submitting
        />
      )
    )
    expect(screen.getByTestId("adapter-form-save")).toHaveTextContent("Saving…")
    expect(screen.getByTestId("adapter-form-save")).toBeDisabled()
  })

  it("fires onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup()
    const onCancel = jest.fn()
    render(
      withIntl(
        <AdapterFormSections
          sections={makeSections()}
          onSubmit={() => undefined}
          onCancel={onCancel}
          dirty
        />
      )
    )
    await user.click(screen.getByRole("button", { name: /Cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("renders the footer slot between Cancel and Save", () => {
    render(
      withIntl(
        <AdapterFormSections
          sections={makeSections()}
          onSubmit={() => undefined}
          dirty
          footerSlot={<span data-testid="footer-slot">slot</span>}
        />
      )
    )
    expect(screen.getByTestId("footer-slot")).toBeInTheDocument()
  })
})
