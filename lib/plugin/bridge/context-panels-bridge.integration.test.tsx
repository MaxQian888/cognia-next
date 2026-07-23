/**
 * @jest-environment jsdom
 *
 * The declarative `manifest.contextPanels` path, end to end:
 *
 *   manifest → validatePluginManifest → registerContextPanelsForPlugin
 *           → contextPanelRegistry → ContextWorkbench render
 *
 * This exists because no in-tree plugin can exercise that path. `contextPanels`
 * resolves its renderer from a separate `entry` module, which `builtin://`
 * plugins have no fetchable install path for, so every first-party contributor
 * is forced onto the imperative API. The declarative half had therefore never
 * been run by anything but per-layer unit tests — which is how the validator
 * came to reject `resourceKinds: ["session"]`, the chat dock's own fallback
 * resource, without anyone noticing.
 */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { ContextWorkbench } from "@/components/context-workbench/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextResource } from "@/types/context-workbench"
import type { PluginManifest } from "@/types/plugin"
import {
  registerContextPanelsForPlugin,
  unregisterContextPanelsForPlugin,
} from "./context-panels-bridge"

jest.mock("@/hooks/chat/use-resource-workbench-session", () => ({
  useResourceWorkbenchSession: () => null,
}))

const PLUGIN_ID = "session-notes"

function manifestFor(overrides: Record<string, unknown> = {}): PluginManifest {
  return {
    id: PLUGIN_ID,
    name: "Session Notes",
    description: "Adds a notes panel to the chat right rail.",
    version: "1.0.0",
    type: "frontend",
    main: "dist/index.js",
    permissions: ["extension:ui", "session:read"],
    capabilities: ["context-panel"],
    contextPanels: [
      {
        id: "notes",
        entry: "dist/panels.js",
        export: "NotesPanel",
        // The kind under test: the dock falls back to `session` whenever no
        // artifact is open, so a panel that cannot target it cannot reach the
        // right rail's default state at all.
        resourceKinds: ["session"],
        activity: "inspect",
        labelKey: "panels.notes",
        label: "Session Notes",
        icon: "file-text",
        ...overrides,
      },
    ],
  } as unknown as PluginManifest
}

const sessionResource: ContextResource = {
  kind: "session",
  sessionId: "session-1",
  capabilities: [],
}

const messages = {
  contextWorkbench: {
    actions: {
      collapse: "Collapse",
      narrow: "Narrow",
      wide: "Wide",
      focus: "Focus",
      pin: "Pin",
      pinHint: "Pin",
      unpin: "Unpin",
      resize: "Resize",
      switchPanel: "Switch panel",
      retry: "Retry",
    },
    panelError: "Panel failed",
    panelErrorDescription: "The panel crashed.",
    activityRailLabel: "Activities",
    aiLoading: "Loading",
  },
}

function renderWorkbench() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContextWorkbench workbenchInstanceId="window-a" resource={sessionResource} />
    </NextIntlClientProvider>
  )
}

async function installPanels(
  manifest: PluginManifest,
  hasPermission: (permission: string) => boolean = () => true
) {
  return registerContextPanelsForPlugin(manifest, "/plugins/session-notes", {
    importer: async () => ({ NotesPanel: () => <div>notes-panel-body</div> }),
    hasPermission,
  })
}

beforeEach(() => {
  useContextWorkbenchStore.setState({ layouts: {} })
})

afterEach(() => unregisterContextPanelsForPlugin(PLUGIN_ID))

describe("declarative context panels, manifest to rendered panel", () => {
  it("validates, registers and renders a session-scoped panel", async () => {
    const manifest = manifestFor()

    const validation = validatePluginManifest(manifest, { governanceMode: "warn" })
    expect(validation.errors).toEqual([])

    expect(await installPanels(manifest)).toEqual({ registered: 1, errors: [] })

    renderWorkbench()
    // Reaching the rail proves `appliesTo` matched the session resource and
    // the permission gate cleared; reaching the body proves the entry module's
    // export is what the workbench actually renders.
    expect(screen.getByRole("button", { name: "Session Notes" })).toBeInTheDocument()
    expect(screen.getByText("notes-panel-body")).toBeInTheDocument()
  })

  it("rejects a resource kind the host does not know", () => {
    const validation = validatePluginManifest(manifestFor({ resourceKinds: ["mailbox"] }), {
      governanceMode: "warn",
    })

    expect(validation.errors.length).toBeGreaterThan(0)
    expect(
      (validation.diagnostics ?? []).some((d) => d.code.endsWith("resourceKinds.invalid"))
    ).toBe(true)
  })

  it("refuses to register at all while a resource permission is withheld", async () => {
    const result = await installPanels(manifestFor(), (p) => p === "extension:ui")

    expect(result.registered).toBe(0)
    expect(result.errors[0]?.message).toMatch(/session:read/)
    expect(contextPanelRegistry.resolve(sessionResource)).toEqual([])
  })

  it("drops an already-registered panel the moment its permission is revoked", async () => {
    // Registration fails closed, so the live gate only matters afterwards —
    // this is the path a revocation from the plugin settings page takes, via
    // `permission-api` calling `contextPanelRegistry.refresh()`.
    const granted = new Set(["extension:ui", "session:read"])
    await installPanels(manifestFor(), (p) => granted.has(p))
    expect(contextPanelRegistry.resolve(sessionResource)).toEqual([
      expect.objectContaining({ id: `${PLUGIN_ID}:notes` }),
    ])

    granted.delete("session:read")
    expect(contextPanelRegistry.resolve(sessionResource)).toEqual([])

    granted.add("session:read")
    expect(contextPanelRegistry.resolve(sessionResource)).toEqual([
      expect.objectContaining({ id: `${PLUGIN_ID}:notes` }),
    ])
  })

  it("hides a panel whose declared capability the resource lacks", async () => {
    await installPanels(manifestFor({ requiredCapabilities: ["run"] }))

    // The session resource above declares no capabilities.
    expect(contextPanelRegistry.resolve(sessionResource)).toEqual([])
    renderWorkbench()
    expect(screen.queryByRole("button", { name: "Session Notes" })).toBeNull()
  })
})
