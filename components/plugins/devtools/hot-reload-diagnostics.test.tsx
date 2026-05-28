import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { HotReloadDiagnostics } from "./hot-reload-diagnostics"
import {
  useHotReloadHistoryStore,
  recordHotReloadEvent,
} from "@/stores/plugin-runtime/hot-reload-history-store"

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  useHotReloadHistoryStore.getState().clear()
})

describe("HotReloadDiagnostics", () => {
  it("shows the empty state when no events have been recorded", () => {
    renderWithIntl(<HotReloadDiagnostics />)
    expect(screen.getByTestId("hot-reload-empty")).toBeInTheDocument()
    expect(screen.getByText(enMessages.plugins.devtools.hotReload.empty)).toBeInTheDocument()
  })

  it("renders a row per recorded event newest-first", () => {
    recordHotReloadEvent({
      pluginId: "alpha",
      source: "cli-bridge",
      kind: "install",
      status: "success",
      timestamp: 1000,
    })
    recordHotReloadEvent({
      pluginId: "beta",
      source: "cli-bridge",
      kind: "hot-reload",
      status: "success",
      timestamp: 2000,
    })
    renderWithIntl(<HotReloadDiagnostics />)
    expect(screen.getByTestId("hot-reload-row-alpha")).toBeInTheDocument()
    expect(screen.getByTestId("hot-reload-row-beta")).toBeInTheDocument()
    const list = screen.getByTestId("hot-reload-list")
    const rows = list.querySelectorAll("li")
    // beta recorded later → appears first
    expect(rows[0]).toHaveAttribute("data-testid", "hot-reload-row-beta")
  })

  it("labels each kind distinctly", () => {
    recordHotReloadEvent({
      pluginId: "alpha",
      source: "cli-bridge",
      kind: "uninstall",
      status: "success",
      timestamp: 1000,
    })
    renderWithIntl(<HotReloadDiagnostics />)
    expect(
      screen.getByText(enMessages.plugins.devtools.hotReload.kindUninstall)
    ).toBeInTheDocument()
  })

  it("clears the history when the clear button is clicked", async () => {
    recordHotReloadEvent({
      pluginId: "alpha",
      source: "cli-bridge",
      kind: "install",
      status: "success",
      timestamp: 1000,
    })
    renderWithIntl(<HotReloadDiagnostics />)
    expect(screen.getByTestId("hot-reload-list")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("hot-reload-clear"))
    expect(screen.queryByTestId("hot-reload-list")).not.toBeInTheDocument()
    expect(screen.getByTestId("hot-reload-empty")).toBeInTheDocument()
  })

  it("does not render the clear button when history is empty", () => {
    renderWithIntl(<HotReloadDiagnostics />)
    expect(screen.queryByTestId("hot-reload-clear")).not.toBeInTheDocument()
  })
})
