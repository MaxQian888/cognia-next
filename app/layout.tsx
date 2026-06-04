// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import Script from "next/script"
import { getLocale } from "next-intl/server"
import { ThemeProvider } from "next-themes"
import { BOOT_SCRIPT } from "@/lib/appearance/boot-script"
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
import { ComputerUseKillSwitchInitializer } from "@/components/providers/initializers/computer-use-kill-switch-initializer"
import { LocalCharacterPackInitializer } from "@/components/providers/initializers/local-character-pack-initializer"
import { ProjectStoreInitializer } from "@/components/providers/initializers/project-store-initializer"
import { ModelsDevCatalogInitializer } from "@/components/providers/initializers/models-dev-catalog-initializer"
import { OcrRuntimeInitializer } from "@/components/providers/initializers/ocr-runtime-initializer"
import { TerminalBridgeInitializer } from "@/components/providers/initializers/terminal-bridge-initializer"
import { PetWindowInitializer } from "@/components/providers/initializers/pet-window-initializer"
import { SchedulerInitializer } from "@/components/scheduler"
import { BackupSchedulerProvider } from "@/components/providers/backup-scheduler-provider"
import { WebDavStartupPromptProvider } from "@/components/providers/webdav-startup-prompt-provider"
import { CompanionBootProvider } from "@/components/providers/companion-boot-provider"
import { MobileShellWrapper } from "@/components/mobile/shell/mobile-shell-wrapper"
import { AppSplash } from "@/components/mobile/splash/app-splash"
import { DesktopAppShell } from "@/components/desktop/desktop-app-shell"
import { ExitConfirmationDialog } from "@/components/desktop/exit-confirmation-dialog"
import { CrashReportDialog } from "@/components/desktop/crash-report-dialog"
import { CompanionEventBridgeProvider } from "@/components/providers/companion-event-bridge-provider"
import { DesktopSyncSourceProvider } from "@/components/providers/desktop-sync-source-provider"
import { DesktopMessageSourceProvider } from "@/components/providers/desktop-message-source-provider"
import { RemoteControlReceiver } from "@/components/providers/remote-control-receiver"
import { CanvasBridgeProvider } from "@/components/providers/canvas-bridge-provider"
import { HookTrustSyncProvider } from "@/components/providers/hook-trust-sync-provider"
import { A2UIDispatchProvider } from "@/components/providers/a2ui-dispatch-provider"
import { PluginToolDispatchProvider } from "@/components/providers/plugin-tool-dispatch-provider"
import { ConnectorBusProvider } from "@/components/connectors/connector-bus-provider"
import { ConnectorDeepLinkRouter } from "@/components/connectors/connector-deep-link-router"
import { ConsentOverlay } from "@/components/automation/consent-overlay"
import { PluginModalRoot } from "@/components/plugins/dialogs/plugin-modal-root"
import { PluginConsentOverlay } from "@/components/plugins/dialogs/plugin-consent-overlay"
import { PluginEnableFailureToaster } from "@/components/plugins/plugin-enable-failure-toaster"
import { PluginErrorToaster } from "@/components/plugins/plugin-error-toaster"
import { CliBridgeEventsBridge } from "@/components/plugins/cli-bridge-events"
import { SubscriptionUsageProvider } from "@/components/providers/subscription-usage-provider"
import {
  BackgroundApplier,
  ComponentStyleApplier,
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
import { PetMount } from "@/components/pet/pet-mount"
import { TtsNowPlayingBar } from "@/components/tts/tts-now-playing-bar"
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
      <head>
        {/* FOUC mitigation — applies a mirrored CSS-var snapshot from
            localStorage before React hydrates so custom themes don't
            flash the default palette on first paint. Owns CSS vars
            only; next-themes still owns the `dark` class. */}
        <Script
          id="cognia-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }}
        />
      </head>
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
                    <ComputerUseKillSwitchInitializer />
                    <TerminalBridgeInitializer />
                    <ExternalAgentInitializer />
                    <LocalCharacterPackInitializer />
                    <ProjectStoreInitializer />
                    <ModelsDevCatalogInitializer />
                    <OcrRuntimeInitializer />
                    <AgentTeamRuntimeInitializer />
                    <SchedulerInitializer />
                    <PetWindowInitializer />
                    <BackupSchedulerProvider>
                      <WebDavStartupPromptProvider>
                        <CompanionEventBridgeProvider>
                          <CanvasBridgeProvider>
                            <HookTrustSyncProvider>
                              <A2UIDispatchProvider>
                                <PluginToolDispatchProvider>
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
                                    <ComponentStyleApplier />
                                    <CustomThemeApplier />
                                    <ConnectorBusProvider>
                                      <ConnectorDeepLinkRouter>
                                        <SubscriptionUsageProvider>
                                          <CompanionBootProvider>
                                            <DesktopSyncSourceProvider>
                                              <DesktopMessageSourceProvider>
                                                {/* Subscribes the renderer to the remote-control axum
                                                    server's Tauri events so inbound HTTP triggers
                                                    actually dispatch. No-op off Tauri. */}
                                                <RemoteControlReceiver>
                                                  <div data-bg-target="global" className="contents">
                                                    <MobileShellWrapper>
                                                      <DesktopAppShell>{children}</DesktopAppShell>
                                                    </MobileShellWrapper>
                                                  </div>
                                                </RemoteControlReceiver>
                                              </DesktopMessageSourceProvider>
                                            </DesktopSyncSourceProvider>
                                          </CompanionBootProvider>
                                        </SubscriptionUsageProvider>
                                      </ConnectorDeepLinkRouter>
                                    </ConnectorBusProvider>
                                  </DataAdapterProvider>
                                </PluginToolDispatchProvider>
                              </A2UIDispatchProvider>
                            </HookTrustSyncProvider>
                          </CanvasBridgeProvider>
                        </CompanionEventBridgeProvider>
                      </WebDavStartupPromptProvider>
                    </BackupSchedulerProvider>
                    <ConsentOverlay />
                    {/* Exit-confirmation prompt — opens when the close button is
                     * pressed and the user's close behavior is "ask". */}
                    <ExitConfirmationDialog />
                    {/* Surfaces an abnormal previous exit (crash) once per launch
                     * with a link to the saved report. No-op on web. */}
                    <CrashReportDialog />
                    {/* Renders any modal a plugin opens via ctx.modal.openModal(). */}
                    {/* See ADR-0026 §3 §A. */}
                    <PluginModalRoot />
                    {/* Per-call consent overlay for tier-"confirm" plugin permissions. */}
                    {/* Listens for `plugin:consent-request` CustomEvents from the broker. */}
                    <PluginConsentOverlay />
                    {/* Toast surface for plugin enable failures fired by
                     * `manager.enablePlugin` rollback path. Translates +
                     * renders so `lib/plugin/core/manager.ts` can stay
                     * decoupled from next-intl. */}
                    <PluginEnableFailureToaster />
                    {/* Generic toast surface for `plugin:error` CustomEvents
                     * dispatched by the rest of the plugin pipeline (install,
                     * config, WASM preload, hot-reload, etc.) via
                     * `lib/plugin/error-bus.ts`. Coexists with the narrower
                     * enable-failure toaster above. */}
                    <PluginErrorToaster />
                    {/* Subscribes to `cli-bridge:*` and global
                     *  `plugin-hot-reload` events emitted by the
                     *  desktop's CLI bridge so installs / uninstalls /
                     *  hot-reloads driven by the `cognia` CLI surface
                     *  in the renderer without a restart. */}
                    <CliBridgeEventsBridge />
                    <ExposeTestGlobals />
                    {/* Dev-only perf HUD. In production it returns null
                     * unless `localStorage.cogniaPerfHud === "1"`. */}
                    <PerfHud />
                    {/* Floating virtual-pet widget — gates itself on the pet
                     * setting and degrades on mobile / reduced motion. */}
                    <PetMount />
                    {/* Global TTS "now playing" bar — self-hides when idle. */}
                    <TtsNowPlayingBar />
                    <Toaster />
                    {/* Branded boot splash on the Capacitor shell — takes over
                     * from the static Android 12 system splash with an animated
                     * circular logo, then fades out. Renders null off mobile. */}
                    <AppSplash />
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
