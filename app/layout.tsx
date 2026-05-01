// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LocaleGate } from "@/components/providers/locale-gate"
import { SettingsSyncProvider } from "@/components/providers/settings-sync-provider"
import { TauriProvider } from "@/components/providers/tauri-provider"
import { LoggerProvider } from "@/components/providers/logger-provider"
import { ExternalAgentInitializer } from "@/components/providers/initializers/external-agent-initializer"
import { SchedulerInitializer } from "@/components/scheduler"
import { BackupSchedulerProvider } from "@/components/providers/backup-scheduler-provider"
import { CanvasBridgeProvider } from "@/components/providers/canvas-bridge-provider"
import { A2UIDispatchProvider } from "@/components/providers/a2ui-dispatch-provider"
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
        >
          <LocaleGate>
            <SettingsSyncProvider>
              <TauriProvider>
                <TooltipProvider>
                  <LoggerProvider>
                    <ExternalAgentInitializer />
                    <SchedulerInitializer />
                    <BackupSchedulerProvider>
                      <CanvasBridgeProvider>
                        <A2UIDispatchProvider>{children}</A2UIDispatchProvider>
                      </CanvasBridgeProvider>
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
