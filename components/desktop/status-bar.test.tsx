/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import { CHROME_BUDGET, countControls } from "@/lib/ui/chrome-budget"

const logInfo = jest.fn()
const logWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
    },
  },
  // Pulled in transitively by the plugin extension slot → extension-api → core/logger.
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

// The notification bell pulls the Dexie-backed store on mount; it's covered by
// its own suite, so stub it here to keep the status-bar test isolated.
jest.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => <button type="button" data-testid="status-notifications" />,
}))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))

jest.mock("@/components/source-control/status-bar-branch", () => ({
  StatusBarBranch: () => <div data-testid="status-branch" />,
}))

jest.mock("@/components/desktop/job-center-panel", () => ({
  JobCenterPanel: () => <button data-testid="status-job-center">Jobs</button>,
}))

// Covered by components/attention/attention-panel.test.tsx; stubbed here so
// the status-bar test does not attach the real aggregation store.
jest.mock("@/components/attention/attention-panel", () => ({
  AttentionPanel: () => <button data-testid="status-attention">Attention</button>,
}))

// New optional segments — covered by their own suites; stub them so the
// status-bar test focuses on layout + gating.
jest.mock("@/components/desktop/status-bar-connectivity", () => ({
  StatusBarConnectivity: () => <div data-testid="status-connectivity" />,
}))
jest.mock("@/components/desktop/status-bar-sync", () => ({
  StatusBarSync: () => <div data-testid="status-sync" />,
}))
jest.mock("@/components/desktop/status-bar-perf", () => ({
  StatusBarPerf: () => <div data-testid="status-perf" />,
}))
jest.mock("@/components/desktop/status-bar-usage", () => ({
  StatusBarUsage: () => <div data-testid="status-usage" />,
}))
jest.mock("@/components/account/account-bar-button", () => ({
  AccountBarButton: () => <div data-testid="account-bar-button" />,
}))

// `stores/index.ts` calls `isTauri()` at module top-level; declaring the
// jest.fn inside the factory dodges the TDZ.
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

jest.mock("@/lib/tauri/webview-zoom", () => {
  const actual = jest.requireActual<typeof import("@/lib/tauri/webview-zoom")>(
    "@/lib/tauri/webview-zoom"
  )
  return { ...actual, applyZoom: jest.fn() }
})

import * as webviewZoom from "@/lib/tauri/webview-zoom"
const applyZoom = webviewZoom.applyZoom as jest.Mock

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ getCharacter: jest.fn() }))

const sessionRef = {
  value: undefined as undefined | { id: string; title: string; characterId?: string },
}
const characterRef = {
  value: undefined as undefined | { id: string; name: string },
}
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    const src = factory.toString()
    if (src.includes("getCharacter")) return characterRef.value
    return sessionRef.value
  },
}))

const chatRef = {
  activeSessionId: null as string | null,
  status: "idle" as "idle" | "streaming" | "awaiting_approval" | "error",
  errorMessage: null as string | null,
  permissionMode: "default" as "default" | "plan" | "acceptEdits" | "bypassPermissions" | null,
}
const setPermissionMode = jest.fn()
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeSessionId: chatRef.activeSessionId,
      status: chatRef.status,
      errorMessage: chatRef.errorMessage,
      permissionMode: chatRef.permissionMode,
      setPermissionMode,
    }),
}))

const toggleSidebar = jest.fn()
const uiRef = { sidebarCollapsed: false }
const barItemsRef: Record<string, boolean> = {
  connectivity: true,
  sync: true,
  perf: false,
  accountStatus: true,
  usage: true,
  workspace: true,
  quickActions: true,
  accountTop: true,
}
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ toggleSidebar, sidebarCollapsed: uiRef.sidebarCollapsed }),
  useBarItemVisible: (id: string) => barItemsRef[id],
}))

const settingsRef = {
  webviewZoom: 1.0 as number | undefined,
  language: "en" as "en" | "zh-CN",
}
const setLanguage = jest.fn().mockResolvedValue(undefined)
const saveSettings = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { webviewZoom: settingsRef.webviewZoom },
      language: settingsRef.language,
      setLanguage,
      save: saveSettings,
    }),
}))

const setTheme = jest.fn()
const themeRef = { value: "system" as "light" | "dark" | "system" | undefined }
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeRef.value, setTheme }),
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}))

import { StatusBar } from "./status-bar"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  isTauriMock.mockReset().mockReturnValue(true)
  applyZoom.mockReset().mockImplementation(async (n: number) => Math.round(n * 20) / 20)
  toggleSidebar.mockReset()
  setPermissionMode.mockReset()
  setLanguage.mockReset().mockResolvedValue(undefined)
  saveSettings.mockReset().mockResolvedValue(undefined)
  setTheme.mockReset()
  routerPush.mockReset()
  chatRef.activeSessionId = null
  chatRef.status = "idle"
  chatRef.errorMessage = null
  chatRef.permissionMode = "default"
  uiRef.sidebarCollapsed = false
  barItemsRef.connectivity = true
  barItemsRef.sync = true
  barItemsRef.perf = false
  barItemsRef.accountStatus = true
  barItemsRef.usage = true
  settingsRef.webviewZoom = 1.0
  settingsRef.language = "en"
  themeRef.value = "system"
  sessionRef.value = undefined
  characterRef.value = undefined
})

// The bar is ambient status now. Theme / zoom / locale moved to the title bar's
// Views menu (covered in `title-bar-layout-controls.test.tsx`), the runtime badge
// and session name were dropped as restatements, and the sidebar + permission
// duplicates went to their single owners.
test("no longer carries the relocated or duplicated segments", () => {
  render(<StatusBar />)
  for (const id of [
    "status-runtime",
    "status-session",
    "status-theme",
    "status-zoom",
    "status-locale",
  ]) {
    expect(screen.queryByTestId(id)).toBeNull()
  }
})

test("renders all top-level segments", () => {
  render(<StatusBar />)
  expect(screen.getByTestId("status-bar")).toBeInTheDocument()
  expect(screen.getByTestId("status-status")).toBeInTheDocument()
  expect(screen.getByTestId("status-notifications")).toBeInTheDocument()
  expect(screen.getByTestId("status-job-center")).toBeInTheDocument()
  // Default-visible optional segments.
  expect(screen.getByTestId("status-connectivity")).toBeInTheDocument()
  expect(screen.getByTestId("account-bar-button")).toBeInTheDocument()
  // Desktop-only segments (isTauri mocked true) with their flags on.
  expect(screen.getByTestId("status-sync")).toBeInTheDocument()
  expect(screen.getByTestId("status-usage")).toBeInTheDocument()
  // Perf defaults off — not mounted.
  expect(screen.queryByTestId("status-perf")).toBeNull()
})

test("gates optional segments on their bar-item flags", () => {
  barItemsRef.connectivity = false
  barItemsRef.sync = false
  barItemsRef.usage = false
  barItemsRef.accountStatus = false
  barItemsRef.perf = true
  render(<StatusBar />)
  expect(screen.queryByTestId("status-connectivity")).toBeNull()
  expect(screen.queryByTestId("status-sync")).toBeNull()
  expect(screen.queryByTestId("status-usage")).toBeNull()
  expect(screen.queryByTestId("account-bar-button")).toBeNull()
  // Perf flag on + desktop → mounted.
  expect(screen.getByTestId("status-perf")).toBeInTheDocument()
})

test("does not mount desktop-only segments in web mode", () => {
  isTauriMock.mockReturnValue(false)
  render(<StatusBar />)
  // Connectivity is meaningful on web; sync/perf/usage are desktop-only.
  expect(screen.getByTestId("status-connectivity")).toBeInTheDocument()
  expect(screen.queryByTestId("status-sync")).toBeNull()
  expect(screen.queryByTestId("status-usage")).toBeNull()
  expect(screen.queryByTestId("status-perf")).toBeNull()
})

// Dedupe: `sidebarCollapsed` had four entry points on one screen and the
// permission mode had two. The bottom bar owns neither now — Views / ⌘B drive
// the sidebar, and the composer chip is the single permission surface.
test("carries neither a sidebar toggle nor a permission picker", () => {
  render(<StatusBar />)
  expect(screen.queryByTestId("status-sidebar")).toBeNull()
  expect(screen.queryByTestId("status-permission")).toBeNull()
  expect(toggleSidebar).not.toHaveBeenCalled()
  expect(setPermissionMode).not.toHaveBeenCalled()
})

// The Advanced group (bypassPermissions / dontAsk / auto) used to live in this
// bar's popover. Its coverage moved with it — see
// `session-settings-sheet.test.tsx` ("offers every permission mode …"), which is
// now the only per-session picker for those modes.

test("status indicator turns into the streaming state with animate-pulse", async () => {
  chatRef.status = "streaming"
  const { container } = render(<StatusBar />)
  await waitFor(() => expect(container.querySelector(".animate-pulse")).toBeTruthy())
})

test.each([
  ["awaiting_approval" as const, "desktop.statusBar.awaitingApproval"],
  ["error" as const, "desktop.statusBar.error"],
  ["idle" as const, "desktop.statusBar.idle"],
])("status %s renders %s label", (status, label) => {
  chatRef.status = status
  render(<StatusBar />)
  expect(screen.getByText(label)).toBeInTheDocument()
})

test("footer is hidden below the mobile breakpoint and shown from md up", () => {
  render(<StatusBar />)
  const footer = screen.getByTestId("status-bar")
  // The VSCode-style desktop bottom bar must not leak into mobile layout
  // (narrow viewports / phone browsers); it only re-appears from `md` (768px).
  expect(footer.className).toContain("hidden")
  expect(footer.className).toContain("md:flex")
})

test("stays within the status-bar chrome control budget", () => {
  render(<StatusBar />)
  // Ratchet, not a target — see lib/ui/chrome-budget.ts. Raising this number
  // means arguing that the bottom bar earned another permanent control.
  expect(countControls(screen.getByTestId("status-bar"))).toBeLessThanOrEqual(
    CHROME_BUDGET.statusBar
  )
})
