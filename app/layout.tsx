// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { getLocale } from "next-intl/server"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LocaleGate } from "@/components/providers/locale-gate"
import { SettingsHydrator } from "@/components/providers/settings-hydrator"
import { SettingsSyncProvider } from "@/components/providers/settings-sync-provider"
import { TauriProvider } from "@/components/providers/tauri-provider"
import { LoggerProvider } from "@/components/providers/logger-provider"
import { ExternalAgentInitializer } from "@/components/providers/initializers/external-agent-initializer"
import { AgentTeamRuntimeInitializer } from "@/components/providers/initializers/agent-team-runtime-initializer"
import { SubscriptionInitializer } from "@/components/providers/initializers/subscription-initializer"
import { AutomationPolicyInitializer } from "@/components/providers/initializers/automation-policy-initializer"
import { AuditRetentionInitializer } from "@/components/providers/initializers/audit-retention-initializer"
import { SchedulerInitializer } from "@/components/scheduler"
import { BackupSchedulerProvider } from "@/components/providers/backup-scheduler-provider"
import { CompanionBootProvider } from "@/components/providers/companion-boot-provider"
import { MobileShellWrapper } from "@/components/mobile/shell/mobile-shell-wrapper"
import { DesktopAppShell } from "@/components/desktop/desktop-app-shell"
import { CompanionEventBridgeProvider } from "@/components/providers/companion-event-bridge-provider"
import { DesktopSyncSourceProvider } from "@/components/providers/desktop-sync-source-provider"
import { DesktopMessageSourceProvider } from "@/components/providers/desktop-message-source-provider"
import { CanvasBridgeProvider } from "@/components/providers/canvas-bridge-provider"
import { A2UIDispatchProvider } from "@/components/providers/a2ui-dispatch-provider"
import { ConnectorBusProvider } from "@/components/connectors/connector-bus-provider"
import { ConnectorDeepLinkRouter } from "@/components/connectors/connector-deep-link-router"
import { ConsentOverlay } from "@/components/automation/consent-overlay"
import { PluginModalRoot } from "@/components/plugins/plugin-modal-root"
import { PluginConsentOverlay } from "@/components/plugins/plugin-consent-overlay"
import { SubscriptionUsageProvider } from "@/components/providers/subscription-usage-provider"
import {
  BackgroundApplier,
  DensityApplier,
  MotionApplier,
  RadiusApplier,
  TypographyApplier,
} from "@/lib/appearance"
import { CustomThemeApplier } from "@/lib/appearance/custom-theme-applier"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import { dexieAdapter } from "@/lib/data-hooks/dexie-adapter"
import { ExposeTestGlobals } from "@/lib/dev/expose-test-globals"
import { PerfHud } from "@/lib/perf"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Cognia · Claude Code",
  description: "Claude Code web client built on top of the Claude Agent SDK",
}

// `viewport-fit: cover` lets the Capacitor WebView paint into the iPhone notch
// and below the Android gesture indicator. Combined with the `.safe-area-*`
// utilities in globals.css (M4.3 / #47) this gives the mobile shell room to
// breathe without leaking into the unsafe edges. Width / scale defaults match
// the Next.js conventions; on desktop the value is a no-op.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const locale = await getLocale()
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          scriptProps={{ suppressHydrationWarning: true }}
        >
          <SettingsHydrator />
          <LocaleGate>
            <SettingsSyncProvider>
              <TauriProvider>
                <TooltipProvider>
                  <LoggerProvider>
                    <SubscriptionInitializer />
                    <AutomationPolicyInitializer />
                    <AuditRetentionInitializer />
                    <ExternalAgentInitializer />
                    <AgentTeamRuntimeInitializer />
                    <SchedulerInitializer />
                    <BackupSchedulerProvider>
                      <CompanionEventBridgeProvider>
                        <CanvasBridgeProvider>
                          <A2UIDispatchProvider>
                            <DataAdapterProvider adapter={dexieAdapter}>
                              {/* Appearance v47 — Typography / density / radius
                                  / motion run before color appliers so the
                                  colorblind & high-contrast transforms in
                                  CustomThemeApplier see stable base values. */}
                              <TypographyApplier />
                              <DensityApplier />
                              <RadiusApplier />
                              <MotionApplier />
                              {/* Keeps body[data-bg-*] + the cognia user-css */}
                              {/* style tag in sync with the appearance store. */}
                              <BackgroundApplier />
                              <CustomThemeApplier />
                              <ConnectorBusProvider>
                                <ConnectorDeepLinkRouter>
                                  <SubscriptionUsageProvider>
                                    <CompanionBootProvider>
                                      <DesktopSyncSourceProvider>
                                        <DesktopMessageSourceProvider>
                                          <div data-bg-target="global" className="contents">
                                            <MobileShellWrapper>
                                              <DesktopAppShell>{children}</DesktopAppShell>
                                            </MobileShellWrapper>
                                          </div>
                                        </DesktopMessageSourceProvider>
                                      </DesktopSyncSourceProvider>
                                    </CompanionBootProvider>
                                  </SubscriptionUsageProvider>
                                </ConnectorDeepLinkRouter>
                              </ConnectorBusProvider>
                            </DataAdapterProvider>
                          </A2UIDispatchProvider>
                        </CanvasBridgeProvider>
                      </CompanionEventBridgeProvider>
                    </BackupSchedulerProvider>
                    <ConsentOverlay />
                    {/* Renders any modal a plugin opens via ctx.modal.openModal(). */}
                    {/* See ADR-0026 §3 §A. */}
                    <PluginModalRoot />
                    {/* Per-call consent overlay for tier-"confirm" plugin permissions. */}
                    {/* Listens for `plugin:consent-request` CustomEvents from the broker. */}
                    <PluginConsentOverlay />
                    <ExposeTestGlobals />
                    {/* Dev-only perf HUD. In production it returns null
                     * unless `localStorage.cogniaPerfHud === "1"`. */}
                    <PerfHud />
                    <Toaster />
                  </LoggerProvider>
                </TooltipProvider>
              </TauriProvider>
            </SettingsSyncProvider>
          </LocaleGate>
        </ThemeProvider>
      </body>
    </html>
  )
}
