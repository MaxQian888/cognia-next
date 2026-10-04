/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import type { ContributedPiPackageView } from "@/hooks/plugins/use-contributed-pi-packages"
import { PiPackageResolutionError } from "@/lib/plugin/pi-packages/resolve"
import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import messages from "@/i18n/messages/en.json"
import { PiPluginPackagesField } from "./pi-plugin-packages-field"

jest.mock("@/hooks/plugins/use-plugin-display-name", () => ({
  usePluginDisplayName: (id: string | null) =>
    id === "latex-workbench" ? "Pi LaTeX Workbench" : (id ?? ""),
}))

let mockViews: ContributedPiPackageView[] = []
jest.mock("@/hooks/plugins/use-contributed-pi-packages", () => ({
  useContributedPiPackages: () => ({ packages: mockViews, loading: false, refresh: jest.fn() }),
}))

function view(
  pluginId: string,
  def: PluginPiPackageDef,
  state: "prepared" | "missing" | null = "prepared",
  error: PiPackageResolutionError | null = null
): ContributedPiPackageView {
  const ref = `${pluginId}/${def.id}` as const
  return {
    entry: { def, installRoot: `/p/${pluginId}`, pluginId, ref },
    resolved:
      state === null
        ? null
        : ({
            ref,
            pluginId,
            def,
            pluginRoot: `/p/${pluginId}`,
            packageDir: `/p/${pluginId}`,
            prepareState: state,
            hosted: Boolean(def.hostedSession),
            extensions: [],
            env: {},
            tools: [],
            controlsSession: false,
          } as ContributedPiPackageView["resolved"]),
    error,
  }
}

const LATEX: PluginPiPackageDef = {
  id: "latex",
  name: "LaTeX",
  path: "pi",
  hostedSession: { extensions: ["pi/x.ts"], tools: ["latex_compile"], controlsSession: true },
}

function renderField(value: string[], onChange = jest.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PiPluginPackagesField value={value} onChange={onChange} />
    </NextIntlClientProvider>
  )
  return onChange
}

describe("PiPluginPackagesField", () => {
  it("offers only packages with hostedSession, with tools and the controlsSession warning", () => {
    mockViews = [
      view("latex-workbench", LATEX),
      view("other", { id: "install-only", name: "Install only", path: "." }),
    ]
    renderField([])
    expect(screen.getByTestId("pi-plugin-package-latex-workbench-latex")).toHaveTextContent(
      "latex_compile"
    )
    expect(
      screen.getByTestId("pi-plugin-package-latex-workbench-latex-controls-session")
    ).toBeInTheDocument()
    expect(screen.queryByText("Install only")).not.toBeInTheDocument()
    expect(screen.getByText("From Pi LaTeX Workbench")).toBeInTheDocument()
  })

  it("adds and removes references in order", async () => {
    const user = userEvent.setup()
    mockViews = [view("latex-workbench", LATEX), view("diagrams", { ...LATEX, id: "mermaid" })]
    const onChange = renderField(["diagrams/mermaid"])
    await user.click(screen.getAllByRole("checkbox")[0])
    expect(onChange).toHaveBeenLastCalledWith(["diagrams/mermaid", "latex-workbench/latex"])
    await user.click(screen.getAllByRole("checkbox")[1])
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it("warns when a package is not prepared or refused", () => {
    mockViews = [
      view("latex-workbench", LATEX, "missing"),
      view(
        "builtin-one",
        { ...LATEX, id: "x" },
        null,
        new PiPackageResolutionError("not-on-disk", "builtin-one/x", "builtin")
      ),
    ]
    renderField([])
    expect(
      screen.getByTestId("pi-plugin-package-latex-workbench-latex-not-ready")
    ).toHaveTextContent("Not prepared")
    expect(screen.getByTestId("pi-plugin-package-builtin-one-x-not-ready")).toHaveTextContent(
      "built-in plugins can't ship Pi packages"
    )
  })

  it("keeps an unavailable saved reference visible with a remove action", async () => {
    const user = userEvent.setup()
    mockViews = []
    const onChange = renderField(["gone/pkg"])
    expect(screen.getByTestId("pi-plugin-packages-empty")).toBeInTheDocument()
    expect(screen.getByTestId("pi-plugin-packages-unavailable")).toHaveTextContent("gone/pkg")
    await user.click(screen.getByRole("button", { name: "Remove" }))
    expect(onChange).toHaveBeenCalledWith([])
  })
})
