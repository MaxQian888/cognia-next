/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import type { LocalPluginInspection } from "@/lib/plugin/local/convert-local-source"

import { LoadUnpackedConversionDialog } from "./load-unpacked-conversion-dialog"

const inspection = (patch: Partial<LocalPluginInspection> = {}): LocalPluginInspection =>
  ({
    sourceFormat: "claude-code",
    report: { fidelity: "structured", converted: [], warnings: [], blocking: [] },
    manifest: { id: "demo", name: "Demo", version: "1.0.0", type: "frontend" },
    generatedFiles: {},
    convertible: true,
    native: false,
    ...patch,
  }) as LocalPluginInspection

const renderDialog = (props: Partial<React.ComponentProps<typeof LoadUnpackedConversionDialog>>) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <LoadUnpackedConversionDialog
        inspection={inspection()}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        {...props}
      />
    </NextIntlClientProvider>
  )

describe("LoadUnpackedConversionDialog", () => {
  it("stays closed with no inspection", () => {
    renderDialog({ inspection: null })
    expect(screen.queryByText("Convert this plugin?")).toBeNull()
  })

  it("names the source format in the prompt", () => {
    renderDialog({})
    expect(screen.getByText(/Claude Code plugins are not a Cognia format/)).toBeInTheDocument()
  })

  it("shows every issue rather than folding them", () => {
    // The GitHub dialog caps its list because it sits beside a README. Here the
    // report IS the decision, so nothing is hidden behind a remainder count.
    const warnings = Array.from({ length: 11 }, (_, index) => ({
      capability: `cap-${index}`,
      path: `p/${index}`,
      message: "not carried over",
      blocking: false,
    }))
    renderDialog({
      inspection: inspection({
        report: {
          fidelity: "structured",
          converted: [],
          warnings,
          blocking: [],
        },
      }),
    })
    expect(screen.getAllByRole("listitem")).toHaveLength(11)
    expect(screen.queryByTestId("fidelity-summary-more")).toBeNull()
  })

  it("refuses an unconvertible bundle while still explaining it", () => {
    renderDialog({
      inspection: inspection({
        convertible: false,
        manifest: undefined,
        report: {
          fidelity: "unsupported",
          converted: [],
          warnings: [],
          blocking: [
            {
              capability: "hooks",
              path: "hooks/x.sh",
              message: "Command hooks have no Cognia equivalent.",
              blocking: true,
            },
          ],
        },
      }),
    })
    expect(screen.getByText(/Command hooks have no Cognia equivalent/)).toBeInTheDocument()
    expect(screen.getByTestId("conversion-blocked")).toBeInTheDocument()
    expect(screen.getByTestId("convert-and-install")).toBeDisabled()
  })

  it("confirms and cancels", async () => {
    const onConfirm = jest.fn()
    const onCancel = jest.fn()
    renderDialog({ onConfirm, onCancel })
    await userEvent.click(screen.getByTestId("convert-and-install"))
    expect(onConfirm).toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("disables both actions while an install is in flight", () => {
    renderDialog({ busy: true })
    expect(screen.getByTestId("convert-and-install")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
  })

  it("keeps the body scrollable inside a bounded dialog", () => {
    // A long report must not push the footer off a phone screen.
    renderDialog({})
    const content = document.querySelector("[data-slot=dialog-content]")
    expect(content?.className).toMatch(/max-h-\[85dvh\]/)
    expect(content?.className).toMatch(/\bflex\b/)
    expect(document.querySelector("[data-slot=scroll-area]")).not.toBeNull()
  })
})
