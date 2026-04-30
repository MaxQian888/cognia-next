import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { LocalPersistenceVisibilityPanel } from "./local-persistence-visibility-panel"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

const messages = {
  settings: {
    data: {
      backendReadiness: {
        title: "Backend readiness",
        description: "Where local data lives.",
        mirroredDomains: "Mirrored domains",
        runtimeMode: {
          desktop: "Desktop runtime",
          web: "Web runtime",
        },
        summary: {
          tauri: "All domains stored in Dexie inside the Tauri shell.",
          web: "All domains stored in IndexedDB via Dexie.",
        },
        domains: {
          chat: "Chat",
          settings: "Settings",
          skills: "Skills",
          canvas: "Canvas",
        },
        noMirroring: "Single backend; no mirroring required.",
        status: {
          completed: "Completed",
          pending: "Pending",
          degraded: "Degraded",
          unavailable: "Unavailable",
        },
      },
    },
  },
}

function renderPanel(props: React.ComponentProps<typeof LocalPersistenceVisibilityPanel> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LocalPersistenceVisibilityPanel {...props} />
    </NextIntlClientProvider>
  )
}

describe("LocalPersistenceVisibilityPanel", () => {
  it("falls back to a web-dexie projection when none provided", () => {
    renderPanel()
    expect(screen.getByText("Web runtime")).toBeInTheDocument()
    expect(screen.getByText("web-dexie")).toBeInTheDocument()
    expect(screen.getByText(/IndexedDB via Dexie/i)).toBeInTheDocument()
    expect(screen.getByText(/Single backend; no mirroring required\./i)).toBeInTheDocument()
  })

  it("renders the supplied projection verbatim", () => {
    renderPanel({
      projection: {
        modeLabel: "Custom mode",
        activeBackendLabel: "tauri-sqlite",
        isDegraded: true,
        summary: "Custom summary",
        diagnosticMessages: ["msg-1", "msg-2"],
        mirroredDomains: [{ id: "x", label: "X", status: "degraded" }],
        reconciliationLabel: "Reconciled",
        recovery: { headline: "Recovered", detail: "ok", warnings: ["warn-1"] },
      },
    })
    expect(screen.getByText("Custom mode")).toBeInTheDocument()
    expect(screen.getByText("tauri-sqlite")).toBeInTheDocument()
    expect(screen.getByText("Custom summary")).toBeInTheDocument()
    expect(screen.getByText("msg-1")).toBeInTheDocument()
    expect(screen.getByText("X: Degraded")).toBeInTheDocument()
    expect(screen.getByText("Recovered")).toBeInTheDocument()
    expect(screen.getByText("warn-1")).toBeInTheDocument()
  })
})
