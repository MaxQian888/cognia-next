// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata, Viewport } from "next"
// Geist ships as a self-hosted local font package (geist/font/*), so the build
// never fetches from fonts.gstatic.com. This keeps offline / proxied / CI and
// the Tauri + Capacitor static-export builds deterministic; the exposed CSS
// variables (--font-geist-sans / --font-geist-mono) are identical to what
// next/font/google emitted, so globals.css needs no change.
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
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
import { AccountAutoLock } from "@/components/account/account-auto-lock"
import { AccountGate } from "@/components/account/account-gate"
import { AccountStoreInitializer } from "@/components/providers/initializers/account-store-initializer"
import { ExternalAgentInitializer } from "@/components/providers/initializers/external-agent-initializer"
import { SubscriptionInitializer } from "@/components/providers/initializers/subscription-initializer"
import { PluginRuntimeInitializer } from "@/components/providers/initializers/plugin-runtime-initializer"
import { ChatMiddlewareFlagInitializer } from "@/components/providers/initializers/chat-middleware-flag-initializer"
import { BackgroundTaskInitializer } from "@/components/providers/initializers/background-task-initializer"
import { ApprovalJournalInitializer } from "@/components/providers/initializers/approval-journal-initializer"
import { AutomationPolicyInitializer } from "@/components/providers/initializers/automation-policy-initializer"
import { AuditRetentionInitializer } from "@/components/providers/initializers/audit-retention-initializer"
import { StorageRetentionInitializer } from "@/components/providers/initializers/storage-retention-initializer"
import { StoragePersistenceInitializer } from "@/components/providers/initializers/storage-persistence-initializer"
import { AutoModeInitializer } from "@/components/providers/initializers/auto-mode-initializer"
import { ProjectStoreInitializer } from "@/components/providers/initializers/project-store-initializer"
import { ModelsDevCatalogInitializer } from "@/components/providers/initializers/models-dev-catalog-initializer"
import { OpenRouterCatalogInitializer } from "@/components/providers/initializers/openrouter-catalog-initializer"
import { OcrRuntimeInitializer } from "@/components/providers/initializers/ocr-runtime-initializer"
import { ProviderCostMirrorInitializer } from "@/components/providers/initializers/provider-cost-mirror-initializer"
import { WindowTitleInitializer } from "@/components/providers/initializers/window-title-initializer"
import { ContextKeysInitializer } from "@/components/providers/initializers/context-keys-initializer"
import { AppShortcutDispatcher } from "@/components/providers/app-shortcut-dispatcher"
import { DeferredBootInitializers } from "@/components/providers/initializers/deferred-boot-initializers"
import { TwinWorkerInitializer } from "@/components/twin/twin-worker-initializer"
import { ProjectKnowledgeWorkerInitializer } from "@/components/shell/project-kb-worker-initializer"
import { BackupSchedulerProvider } from "@/components/providers/backup-scheduler-provider"
import { WebDavStartupPromptProvider } from "@/components/providers/webdav-startup-prompt-provider"
import { WebDavMobileAutosyncProvider } from "@/components/providers/webdav-mobile-autosync-provider"
import { CompanionBootProvider } from "@/components/providers/companion-boot-provider"
import { WebCompanionBootProvider } from "@/components/providers/web-companion-boot-provider"
import { MobileShellWrapper } from "@/components/mobile/shell/mobile-shell-wrapper"
import { DesktopOnlyInitializers } from "@/components/providers/initializers/desktop-only-initializers"
import { MobileOnlyInitializers } from "@/components/providers/initializers/mobile-only-initializers"
import { DesktopAppShell } from "@/components/desktop/desktop-app-shell"
import { CompanionEventBridgeProvider } from "@/components/providers/companion-event-bridge-provider"
import { DesktopSyncSourceProvider } from "@/components/providers/desktop-sync-source-provider"
import { DesktopMessageSourceProvider } from "@/components/providers/desktop-message-source-provider"
import { RemoteControlReceiver } from "@/components/providers/remote-control-receiver"
import { CanvasBridgeProvider } from "@/components/providers/canvas-bridge-provider"
import { HookTrustSyncProvider } from "@/components/providers/hook-trust-sync-provider"
import { A2UIDispatchProvider } from "@/components/providers/a2ui-dispatch-provider"
import { A2UIBuiltInActionsProvider } from "@/components/providers/a2ui-built-in-actions-provider"
import { PluginToolDispatchProvider } from "@/components/providers/plugin-tool-dispatch-provider"
import { ConnectorDeepLinkRouter } from "@/components/connectors/connector-deep-link-router"
import { PluginModalRoot } from "@/components/plugins/dialogs/plugin-modal-root"
import { PluginConsentOverlay } from "@/components/plugins/dialogs/plugin-consent-overlay"
import { PluginEnableFailureToaster } from "@/components/plugins/plugin-enable-failure-toaster"
import { PluginErrorToaster } from "@/components/plugins/plugin-error-toaster"
import { WorkflowRunToaster } from "@/components/workflow/runs/workflow-run-toaster"
import { OrchestrationDispatchProvider } from "@/components/providers/orchestration-dispatch-provider"
import { SubscriptionUsageProvider } from "@/components/providers/subscription-usage-provider"
import { McpLogProvider } from "@/components/providers/mcp-log-provider"
import {
  BackgroundApplier,
  ComponentStyleApplier,
  DensityApplier,
  MotionApplier,
  RadiusApplier,
  TypographyApplier,
} from "@/lib/appearance"
import { CustomThemeApplier } from "@/lib/appearance/custom-theme-applier"
import { PluginThemeApplier } from "@/lib/appearance/plugin-theme-applier"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import { dexieAdapter } from "@/lib/data-hooks/dexie-adapter"
import { ExposeTestGlobals } from "@/lib/dev/expose-test-globals"
import { PerfHud } from "@/lib/perf"
import { PetMount } from "@/components/pet/pet-mount"
import { CaptureMount } from "@/components/capture/capture-mount"
import { PetWindowShell } from "@/components/pet/pet-window-shell"
import { TtsNowPlayingBar } from "@/components/tts/tts-now-playing-bar"
import { AskUserDialog } from "@/components/chat/ask-user-dialog"
import "./globals.css"

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
  // Keyboard avoidance (pure-CSS dvh strategy): on Android Chromium WebViews
  // this makes the on-screen keyboard *resize* the layout viewport (so
  // `100dvh` shrinks and the composer rides above the keyboard) instead of
  // overlaying it. iOS Safari/WebView ignores it and relies on dvh +
  // Capacitor's native keyboard resize. No JS visualViewport observer.
  interactiveWidget: "resizes-content",
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
      <body className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          scriptProps={{ suppressHydrationWarning: true }}
        >
          {/* The transparent desktop-pet windows (/pet-overlay, /pet-popup)
              render ONLY the minimal petShell tree — booting the full app
              runtime in those webviews caused severe lag and opaque paints
              inside what must be paint-through windows. Route-keyed so the
              prerendered HTML and hydration agree; see pet-window-shell.tsx. */}
          <PetWindowShell
            petShell={
              <LocaleGate>
                <SettingsHydrator />
                <SettingsSyncProvider>
                  <TooltipProvider>{children}</TooltipProvider>
                </SettingsSyncProvider>
              </LocaleGate>
            }
          >
            <AccountStoreInitializer />
            <LocaleGate>
              <AccountGate>
                <SettingsHydrator />
                <AccountAutoLock />
                <SettingsSyncProvider>
                  <TauriProvider>
                    <TooltipProvider>
                      <LoggerProvider>
                        {/* Boots the plugin platform (manager + built-in plugin
                         * discovery + onStartup activation). Must run before any
                         * surface that reads plugin registries or calls
                         * getPluginManager(). */}
                        <PluginRuntimeInitializer />
                        <ChatMiddlewareFlagInitializer />
                        <BackgroundTaskInitializer />
                        <ApprovalJournalInitializer />
                        <SubscriptionInitializer />
                        {/* Desktop-only boot initializers (Tauri). Consolidated +
                         * runtime-gated + dynamically imported so the browser dev
                         * server never compiles their subsystem graphs; the Tauri
                         * build loads them at runtime. See the component for the
                         * full rationale. */}
                        <DesktopOnlyInitializers />
                        <AutomationPolicyInitializer />
                        <AuditRetentionInitializer />
                        <StorageRetentionInitializer />
                        <StoragePersistenceInitializer />
                        <AutoModeInitializer />
                        <ExternalAgentInitializer />
                        <ProjectStoreInitializer />
                        <ModelsDevCatalogInitializer />
                        <OpenRouterCatalogInitializer />
                        <OcrRuntimeInitializer />
                        {/* Agent-team, scheduler, workflow-trigger, provider-
                         * routing, gateway, and connector runtimes — bundled
                         * behind one dynamic(ssr:false) boundary so their
                         * subsystem graphs stay out of every route's
                         * first-paint compile (ADR-0068 C3). Mount order
                         * inside the bundle preserves the previous document
                         * order here, incl. Routing-before-Gateway. */}
                        <DeferredBootInitializers />
                        <TwinWorkerInitializer />
                        {/* Keeps each workspace's project-scoped RAG index
                         * (`projectChunks`) in sync with its `knowledgeBase`.
                         * No-op when no vector backend is configured. */}
                        <ProjectKnowledgeWorkerInitializer />
                        <ProviderCostMirrorInitializer />
                        <ContextKeysInitializer />
                        {/* Single keydown listener for all rebindable in-app
                         * (renderer-scope) shortcuts. Reads the context-key
                         * store, so it mounts after ContextKeysInitializer. */}
                        <AppShortcutDispatcher />
                        <WindowTitleInitializer />
                        <BackupSchedulerProvider>
                          <WebDavStartupPromptProvider>
                            <WebDavMobileAutosyncProvider>
                              <CompanionEventBridgeProvider>
                                <CanvasBridgeProvider>
                                  <HookTrustSyncProvider>
                                    <A2UIDispatchProvider>
                                      {/* Global, single-instance built-in A2UI action handling
                                          (calculator/timer/todo/…). Renders null — mounted here
                                          so every route's surfaces are interactive. */}
                                      <A2UIBuiltInActionsProvider />
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
                                          {/* Applies a directly-activated plugin theme as a
                                  <style data-plugin-theme> block. Mutually
                                  exclusive with CustomThemeApplier's inline
                                  vars (see plugin-theme-applier.tsx). */}
                                          <PluginThemeApplier />
                                          <ConnectorDeepLinkRouter>
                                            <SubscriptionUsageProvider>
                                              <McpLogProvider>
                                                <CompanionBootProvider>
                                                  <WebCompanionBootProvider>
                                                    <DesktopSyncSourceProvider>
                                                      <DesktopMessageSourceProvider>
                                                        {/* Subscribes the renderer to the remote-control axum
                                                    server's Tauri events so inbound HTTP triggers
                                                    actually dispatch. No-op off Tauri. */}
                                                        <RemoteControlReceiver>
                                                          {/* id="app" is the scope root for user
                                                        custom CSS when `customCssScope` is
                                                        "app" (see lib/appearance/custom-css/apply).
                                                        display:contents keeps it box-less but
                                                        still a valid @scope (#app) root. */}
                                                          <div
                                                            id="app"
                                                            data-bg-target="global"
                                                            className="contents"
                                                          >
                                                            <MobileShellWrapper>
                                                              <DesktopAppShell>
                                                                {children}
                                                              </DesktopAppShell>
                                                            </MobileShellWrapper>
                                                          </div>
                                                        </RemoteControlReceiver>
                                                      </DesktopMessageSourceProvider>
                                                    </DesktopSyncSourceProvider>
                                                  </WebCompanionBootProvider>
                                                </CompanionBootProvider>
                                              </McpLogProvider>
                                            </SubscriptionUsageProvider>
                                          </ConnectorDeepLinkRouter>
                                        </DataAdapterProvider>
                                      </PluginToolDispatchProvider>
                                    </A2UIDispatchProvider>
                                  </HookTrustSyncProvider>
                                </CanvasBridgeProvider>
                              </CompanionEventBridgeProvider>
                            </WebDavMobileAutosyncProvider>
                          </WebDavStartupPromptProvider>
                        </BackupSchedulerProvider>
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
                        {/* Global live progress for workflow runs started outside
                         * the editor (library Run button, /workflow chat command,
                         * IM/API). Editor/run-list runs keep their own inline
                         * toasts. */}
                        <WorkflowRunToaster />
                        {/* Thread D4 — bounces sidecar/external-agent orchestration
                         *  calls (agent_dispatch / team_run / plugin_tool_invoke)
                         *  to the renderer entry points. No-op in web. */}
                        <OrchestrationDispatchProvider />
                        <ExposeTestGlobals />
                        {/* Dev-only perf HUD. In production it returns null
                         * unless `localStorage.cogniaPerfHud === "1"`. */}
                        <PerfHud />
                        {/* Floating virtual-pet widget — gates itself on the pet
                         * setting and degrades on mobile / reduced motion. */}
                        <PetMount />
                        {/* Content-capture confirm bubble + clipboard watcher —
                         * self-gates on the capture setting (disabled by default). */}
                        <CaptureMount />
                        {/* Global TTS "now playing" bar — self-hides when idle. */}
                        <TtsNowPlayingBar />
                        {/* Modal for the agent's `ask_user` tool — self-hides when
                         * no prompt is pending. */}
                        <AskUserDialog />
                        <Toaster />
                        {/* Capacitor-only boot surfaces (splash). Consolidated +
                         * runtime-gated + dynamically imported; the browser/Tauri
                         * dev server never compiles them, the mobile build loads
                         * them at runtime. */}
                        <MobileOnlyInitializers />
                      </LoggerProvider>
                    </TooltipProvider>
                  </TauriProvider>
                </SettingsSyncProvider>
              </AccountGate>
            </LocaleGate>
          </PetWindowShell>
        </ThemeProvider>
      </body>
    </html>
  )
}
