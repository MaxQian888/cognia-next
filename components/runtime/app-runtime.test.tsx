jest.mock("@/components/providers/full-messages-gate", () => ({
  LocaleReadyContext: jest.requireActual("react").createContext(true),
  FullMessagesGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/components/desktop/desktop-app-shell", () => ({
  DesktopAppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/components/account/cloud-sign-in-gate", () => ({
  CloudSignInGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/components/providers/onboarding-gate", () => ({
  OnboardingGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
let mockPathname = "/"
let mockAccount = "open"
let mockRecovery = false
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock("@/components/providers/initializers/window-liveness-initializers", () => ({
  WindowLivenessInitializers: () => <span data-testid="window-liveness" />,
}))
jest.mock("@/components/providers/initializers/mobile-only-initializers", () => ({
  MobileNativeSplashInitializer: () => <span data-testid="native-splash-handoff" />,
  MobileOnlyInitializers: () => <span data-testid="mobile-splash-overlay" />,
}))
jest.mock("@/components/error/db-upgrade-blocked-dialog", () => ({
  DbUpgradeBlockedDialog: () => <span data-testid="db-upgrade-error" />,
}))
jest.mock("@/components/providers/initializers/plugin-runtime-initializer", () => ({
  PluginRuntimeInitializer: () => <span data-testid="plugin-runtime" />,
}))
// These hosts render nothing while idle. Sentinels catch missing or duplicate
// mounts in the production tree; each host's own suite exercises its behavior.
jest.mock("@/components/plugins/dialogs/plugin-modal-root", () => ({
  PluginModalRoot: () => <span data-testid="plugin-modal-root" />,
}))
jest.mock("@/components/plugins/dialogs/plugin-consent-overlay", () => ({
  PluginConsentOverlay: () => <span data-testid="plugin-consent-overlay" />,
}))
jest.mock("@/components/plugins/plugin-permission-request-host", () => ({
  PluginPermissionRequestHost: () => <span data-testid="plugin-permission-request-host" />,
}))
jest.mock("@/components/plugins/plugin-enable-failure-toaster", () => ({
  PluginEnableFailureToaster: () => <span data-testid="plugin-enable-failure-toaster" />,
}))
jest.mock("@/components/providers/recovery-boot-gate", () => ({
  RecoveryBootGate: ({ children }: { children: React.ReactNode }) =>
    mockRecovery ? <span data-testid="recovery" /> : <>{children}</>,
}))
jest.mock("@/components/account/account-gate", () => ({
  AccountGate: ({
    children,
    guestView,
  }: {
    children: React.ReactNode
    guestView: React.ReactNode
  }) => {
    if (mockAccount === "locked") return <span data-testid="account-locked" />
    if (mockAccount === "guest") return <>{guestView}</>
    return <>{children}</>
  },
}))

import { renderToStaticMarkup } from "react-dom/server"
import { AppRuntime } from "./app-runtime"

const pluginHosts = [
  "plugin-modal-root",
  "plugin-consent-overlay",
  "plugin-permission-request-host",
  "plugin-enable-failure-toaster",
]

function expectNoPluginHosts(markup: string) {
  for (const host of pluginHosts) {
    expect(markup).not.toContain(`data-testid="${host}"`)
  }
}

const renderRuntime = () =>
  renderToStaticMarkup(
    <AppRuntime>
      <main>page content</main>
    </AppRuntime>
  )

describe("AppRuntime boot boundaries", () => {
  afterEach(() => {
    mockPathname = "/"
    mockAccount = "open"
    mockRecovery = false
  })

  it("keeps liveness, native splash handoff and database errors visible before unlock", () => {
    mockAccount = "locked"
    const markup = renderRuntime()
    expect(markup).toContain('data-testid="window-liveness"')
    expect(markup).toContain('data-testid="native-splash-handoff"')
    expect(markup).toContain('data-testid="db-upgrade-error"')
    expect(markup).toContain('data-testid="account-locked"')
    expect(markup).not.toContain('data-testid="plugin-runtime"')
    expect(markup).not.toContain('data-testid="mobile-splash-overlay"')
    expect(markup).not.toContain("page content")
    expectNoPluginHosts(markup)
  })

  it("holds all post-recovery plugin and app surfaces back in recovery mode", () => {
    mockRecovery = true
    const markup = renderRuntime()
    expect(markup).toContain('data-testid="recovery"')
    expect(markup).not.toContain('data-testid="plugin-runtime"')
    expect(markup).not.toContain('data-testid="mobile-splash-overlay"')
    expect(markup).not.toContain("page content")
    expectNoPluginHosts(markup)
  })

  it("lets lightweight routes render without account gating or app initializers", () => {
    mockPathname = "/status"
    mockAccount = "locked"
    const markup = renderRuntime()
    expect(markup).toContain("<main>page content</main>")
    expect(markup).not.toContain('data-testid="window-liveness"')
    expect(markup).not.toContain('data-testid="account-locked"')
    expect(markup).not.toContain('data-testid="plugin-runtime"')
    expectNoPluginHosts(markup)
  })

  it.each(["open", "locked"])(
    "renders the web callback outside account and recovery gates with account state %s",
    (account) => {
      mockPathname = "/logto/callback"
      mockAccount = account
      mockRecovery = true
      const markup = renderRuntime()
      expect(markup).toContain("<main>page content</main>")
      expect(markup).not.toContain('data-testid="account-locked"')
      expect(markup).not.toContain('data-testid="recovery"')
      expect(markup).not.toContain('data-testid="plugin-runtime"')
      expectNoPluginHosts(markup)
    }
  )

  it("renders the anonymous shared page without the authenticated runtime", () => {
    mockAccount = "guest"
    const markup = renderRuntime()
    expect(markup).toContain('data-testid="share-guest-shell"')
    expect(markup).toContain("<main>page content</main>")
    expect(markup).not.toContain('data-testid="plugin-runtime"')
    expectNoPluginHosts(markup)
  })

  it("keeps app content and mobile splash inside the unlocked runtime", () => {
    const markup = renderRuntime()
    expect(markup).toContain("<main>page content</main>")
    expect(markup).toContain('data-testid="plugin-runtime"')
    expect(markup).toContain('data-testid="mobile-splash-overlay"')
  })

  it.each(pluginHosts)("mounts %s exactly once in the unlocked production runtime", (host) => {
    const markup = renderRuntime()
    expect(markup.split(`data-testid="${host}"`)).toHaveLength(2)
  })
})
