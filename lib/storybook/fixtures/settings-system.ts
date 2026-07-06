// Storybook-only fixture builders for the Settings → Sections / Sandbox / Pet
// store-reading components. These read the global `useSettingsStore` and fall
// back to library defaults when fields are absent, so stories seed a realistic
// `AppSettings`-shaped blob covering only the fields the panel under test reads.
// The full `AppSettings` type is large; we build the subset and cast through
// `unknown`, mirroring `lib/storybook/fixtures/settings-search.ts`.
import type { AppSettings } from "@/lib/claude/types"
import type { AutomationAuditLogRow } from "@/lib/automation/audit"

/**
 * Build an `AppSettings`-shaped blob carrying only the fields a settings panel
 * reads. The store falls back to defaults for everything untouched, so the cast
 * through `unknown` is intentional and limited to Storybook seeding.
 */
export function makeAppSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const base = {
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    canvasCodeSandboxEnabled: true,
  }
  return { ...base, ...overrides } as unknown as AppSettings
}

const MIN = 60_000

/**
 * A spread of automation audit rows across the last hour — a mix of surfaces
 * (sandbox / computerUse / workflow) and decisions (allow / deny / consent)
 * so both the sandbox-only audit card and the full audit table render
 * meaningfully. `surface: "sandbox"` rows are what `SandboxAuditCard` filters
 * for; the rest exercise the surface/decision filters on the audit table.
 */
export function makeAutomationAuditRows(now: number = Date.now()): AutomationAuditLogRow[] {
  return [
    {
      id: "audit-1",
      ts: now - 2 * MIN,
      surface: "sandbox",
      pluginId: null,
      command: "sandbox_exec",
      processName: "python.exe",
      windowTitle: null,
      decision: "allow",
      reason: null,
      durationMs: 184,
      error: null,
    },
    {
      id: "audit-2",
      ts: now - 6 * MIN,
      surface: "sandbox",
      pluginId: null,
      command: "sandbox_exec",
      processName: "node.exe",
      windowTitle: null,
      decision: "deny",
      reason: "network egress blocked",
      durationMs: 12,
      error: "EPERM: network disabled",
    },
    {
      id: "audit-3",
      ts: now - 9 * MIN,
      surface: "computerUse",
      pluginId: null,
      command: "screenshot",
      processName: "explorer.exe",
      windowTitle: "Desktop",
      decision: "allow",
      reason: null,
      durationMs: 73,
      error: null,
    },
    {
      id: "audit-4",
      ts: now - 14 * MIN,
      surface: "workflow",
      pluginId: null,
      command: "click",
      processName: "chrome.exe",
      windowTitle: "Cognia — Google Chrome",
      decision: "consent",
      reason: "per-call tier",
      durationMs: 51,
      error: null,
    },
    {
      id: "audit-5",
      ts: now - 22 * MIN,
      surface: "plugin",
      pluginId: "computer-use",
      command: "type",
      processName: "notepad.exe",
      windowTitle: "Untitled - Notepad",
      decision: "allow",
      reason: null,
      durationMs: 28,
      error: null,
    },
  ]
}
