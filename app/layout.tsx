// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
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
import { SchedulerInitializer } from "@/components/scheduler"
import { BackupSchedulerProvider } from "@/components/providers/backup-scheduler-provider"
import { CompanionBootProvider } from "@/components/providers/companion-boot-provider"
import { CompanionEventBridgeProvider } from "@/components/providers/companion-event-bridge-provider"
import { DesktopSyncSourceProvider } from "@/components/providers/desktop-sync-source-provider"
import { CanvasBridgeProvider } from "@/components/providers/canvas-bridge-provider"
import { A2UIDispatchProvider } from "@/components/providers/a2ui-dispatch-provider"
import { ConnectorBusProvider } from "@/components/connectors/connector-bus-provider"
import { ConnectorDeepLinkRouter } from "@/components/connectors/connector-deep-link-router"
import { SubscriptionUsageProvider } from "@/components/providers/subscription-usage-provider"
import { BackgroundApplier } from "@/lib/appearance"
import { CustomThemeApplier } from "@/lib/appearance/custom-theme-applier"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import { dexieAdapter } from "@/lib/data-hooks/dexie-adapter"
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
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
                    <ExternalAgentInitializer />
                    <AgentTeamRuntimeInitializer />
                    <SchedulerInitializer />
                    <BackupSchedulerProvider>
                      <CompanionEventBridgeProvider>
                        <CanvasBridgeProvider>
                          <A2UIDispatchProvider>
                            <DataAdapterProvider adapter={dexieAdapter}>
                              {/* Keeps body[data-bg-*] + the cognia user-css */}
                              {/* style tag in sync with the appearance store. */}
                              <BackgroundApplier />
                              <CustomThemeApplier />
                              <ConnectorBusProvider>
                                <ConnectorDeepLinkRouter>
                                  <SubscriptionUsageProvider>
                                    <CompanionBootProvider>
                                      <DesktopSyncSourceProvider>
                                        <div data-bg-target="global" className="contents">
                                          {children}
                                        </div>
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
