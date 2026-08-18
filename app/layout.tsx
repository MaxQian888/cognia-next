// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata, Viewport } from "next"
import dynamic from "next/dynamic"
import { Suspense } from "react"
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
import { RecoveryBootGate } from "@/components/providers/recovery-boot-gate"
import { OnboardingGate } from "@/components/providers/onboarding-gate"
import { AccountAutoLock } from "@/components/account/account-auto-lock"
import { AccountGate } from "@/components/account/account-gate"
import { AccountStoreInitializer } from "@/components/providers/initializers/account-store-initializer"
import { SubscriptionInitializer } from "@/components/providers/initializers/subscription-initializer"
import { PluginRuntimeInitializer } from "@/components/providers/initializers/plugin-runtime-initializer"
import { ChatMiddlewareFlagInitializer } from "@/components/providers/initializers/chat-middleware-flag-initializer"
import { DeveloperModeInitializer } from "@/components/providers/initializers/developer-mode-initializer"
import { ApprovalJournalInitializer } from "@/components/providers/initializers/approval-journal-initializer"
import { AuditRetentionInitializer } from "@/components/providers/initializers/audit-retention-initializer"
import { StorageRetentionInitializer } from "@/components/providers/initializers/storage-retention-initializer"
import { StoragePersistenceInitializer } from "@/components/providers/initializers/storage-persistence-initializer"
import { ProjectStoreInitializer } from "@/components/providers/initializers/project-store-initializer"
import { IssueTrackerInitializer } from "@/components/providers/initializers/issue-tracker-initializer"
import { WindowTitleInitializer } from "@/components/providers/initializers/window-title-initializer"
import { ContextKeysInitializer } from "@/components/providers/initializers/context-keys-initializer"
import { SessionFocusInitializer } from "@/components/providers/initializers/session-focus-initializer"
import { AppShortcutDispatcher } from "@/components/providers/app-shortcut-dispatcher"
import { DeferredBootInitializers } from "@/components/providers/initializers/deferred-boot-initializers"
import { BootCapabilityRouteActivator } from "@/components/providers/initializers/boot-capability-route-activator"
import { BootProfileStartupProbe } from "@/components/providers/initializers/boot-profile-startup-probe"
import { WindowLivenessInitializers } from "@/components/providers/initializers/window-liveness-initializers"
import { RendererPerfInitializer } from "@/components/providers/initializers/renderer-perf-initializer"
import { BackupSchedulerProvider } from "@/components/providers/backup-scheduler-provider"
import { WebDavStartupPromptProvider } from "@/components/providers/webdav-startup-prompt-provider"
import { WebDavMobileAutosyncProvider } from "@/components/providers/webdav-mobile-autosync-provider"
import { CompanionBootProvider } from "@/components/providers/companion-boot-provider"
import { WebCompanionBootProvider } from "@/components/providers/web-companion-boot-provider"
import { SurfaceAvailabilityBoundary } from "@/components/runtime/surface-availability-boundary"
import { MobileShellWrapper } from "@/components/mobile/shell/mobile-shell-wrapper"
import { DesktopOnlyInitializers } from "@/components/providers/initializers/desktop-only-initializers"
import { MobileOnlyInitializers } from "@/components/providers/initializers/mobile-only-initializers"
import { DesktopAppShell } from "@/components/desktop/desktop-app-shell"
import { CompanionEventBridgeProvider } from "@/components/providers/companion-event-bridge-provider"
import { DesktopSyncSourceProvider } from "@/components/providers/desktop-sync-source-provider"
import { DesktopMessageSourceProvider } from "@/components/providers/desktop-message-source-provider"
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
import { SettingsLoadFailedBanner } from "@/components/error/settings-load-failed-banner"
import { FinishSetupBar } from "@/components/onboarding/finish-setup-bar"
import { DbUpgradeBlockedDialog } from "@/components/error/db-upgrade-blocked-dialog"
import { DiagnosticNotifier } from "@/components/error/diagnostic-notifier"
import { ReportProblemHost } from "@/components/support/report-problem-host"
import { WorkflowRunToaster } from "@/components/workflow/runs/workflow-run-toaster"
import { OrchestrationDispatchProvider } from "@/components/providers/orchestration-dispatch-provider"
import { SubscriptionUsageProvider } from "@/components/providers/subscription-usage-provider"
import { McpLogProvider } from "@/components/providers/mcp-log-provider"
import { SidecarSpanProvider } from "@/components/providers/sidecar-span-provider"
import {
  BackgroundApplier,
  ComponentStyleApplier,
  CursorApplier,
  DensityApplier,
  MotionApplier,
  RadiusApplier,
  TypographyApplier,
} from "@/lib/appearance"
import { CursorEffectLayer } from "@/components/appearance/cursor-effect-layer"
import { CustomThemeApplier } from "@/lib/appearance/custom-theme-applier"
import { PluginThemeApplier } from "@/lib/appearance/plugin-theme-applier"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import { dexieAdapter } from "@/lib/data-hooks/dexie-adapter"
import { ExposeTestGlobals } from "@/lib/dev/expose-test-globals"
import { PerfHud } from "@/lib/perf"
import { PetMount } from "@/components/pet/pet-mount"
import { CaptureMount } from "@/components/capture/capture-mount"
import { LightweightRouteShell } from "@/components/runtime/lightweight-route-shell"
import { TtsNowPlayingBar } from "@/components/tts/tts-now-playing-bar"
import { AskUserDialog } from "@/components/chat/ask-user-dialog"
import { SkillRecorderRoot } from "@/components/skills/recorder/recorder-root"
import "./globals.css"

// This harness reaches nearly every plugin surface and renderer by design.
// Keeping it as a static import made ordinary `pnpm dev` compile the E2E-only
// graph even though NEXT_PUBLIC_E2E is unset. The conditional render below now
// has a real module boundary; E2E builds still load the exact same component.
const PluginSurfaceReferenceHarness = dynamic(() =>
  import("@/app/e2e/plugin-ui-surfaces/plugin-surface-reference-harness").then(
    (module) => module.PluginSurfaceReferenceHarness
  )
)

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
          {/* Lightweight routes render only locale, settings/theme, and tooltip
              providers. This keeps transparent overlay windows paint-through
              and lets the public /status document bypass account gating and
              the authenticated app runtime. Route-keyed so static-export HTML
              and hydration agree; see lightweight-route-shell.tsx. */}
          <LightweightRouteShell
            lightweightShell={
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
              {process.env.NEXT_PUBLIC_E2E === "1" ? (
                <>
                  <PluginRuntimeInitializer onlyForPluginSurfaceE2E />
                  <PluginSurfaceReferenceHarness />
                </>
              ) : null}
              {/* Reveals the hidden Tauri main window on first paint and starts
                  the white-screen watchdog heartbeat. Mounted ABOVE AccountGate
                  so a locked / first-run cold boot (which never renders the
                  gate's children) still shows the themed lock/create screen
                  immediately instead of an 8-second black window. Inside
                  LocaleGate because the heartbeat consumes i18n. */}
              <WindowLivenessInitializers />
              {/* A stuck Dexie schema upgrade hangs boot before AccountGate ever
                  renders its children, so this sits ABOVE the gate for the same
                  reason WindowLivenessInitializers does — otherwise the one
                  screen explaining the freeze would itself be unreachable.
                  Inside LocaleGate because it needs i18n. Renders null until
                  `getDb()` actually gives up. */}
              <DbUpgradeBlockedDialog />
              {/* E2E transport/fixture seams must mount even when AccountGate is
                  waiting on a first-open schema upgrade. The component is a
                  production no-op unless NEXT_PUBLIC_E2E=1. */}
              <ExposeTestGlobals />
              <AccountGate>
                <SettingsHydrator />
                <AccountAutoLock />
                <SettingsSyncProvider>
                  <TauriProvider>
                    <TooltipProvider>
                      <LoggerProvider>
                        {/* ADR-0102 §4 — the recovery boot gate. Sits here, and
                         * only here: after account unlock, locale, logging and
                         * Tauri IPC (the diagnostics shell needs all four), and
                         * ABOVE every plugin/background initializer below,
                         * because holding those back is what safe mode is.
                         * Renders its children unchanged on a healthy boot and
                         * synchronously on web/mobile, where there is no safe
                         * mode to enter. */}
                        <RecoveryBootGate>
                          {/* First-run routing (ADR-0122). Sits BELOW
                           * RecoveryBootGate — the app being broken outranks the
                           * question of whether the user is new — and ABOVE the
                           * shells, so a first-run device never paints the chat
                           * workspace behind the flow. It reads the settings row,
                           * so it must stay under SettingsHydrator. Renders its
                           * children unchanged for everyone already onboarded, and
                           * always on `/onboarding` itself so the Settings
                           * "run setup again" entry point works. */}
                          <OnboardingGate>
                            {/* Boots the plugin platform (manager + built-in plugin
                             * discovery + onStartup activation). Must run before any
                             * surface that reads plugin registries or calls
                             * getPluginManager(). */}
                            <PluginRuntimeInitializer />
                            <DeveloperModeInitializer />
                            <ChatMiddlewareFlagInitializer />
                            <ApprovalJournalInitializer />
                            <SubscriptionInitializer />
                            {/* Desktop-only boot initializers (Tauri). Consolidated +
                             * runtime-gated + dynamically imported so the browser dev
                             * server never compiles their subsystem graphs; the Tauri
                             * build loads them at runtime. See the component for the
                             * full rationale. */}
                            <DesktopOnlyInitializers />
                            <AuditRetentionInitializer />
                            <StorageRetentionInitializer />
                            <StoragePersistenceInitializer />
                            <ProjectStoreInitializer />
                            <IssueTrackerInitializer />
                            {/* Capability-scoped dynamic boundaries keep optional
                             * subsystem graphs out of the main profile's initial
                             * compile. Production/eager requests every group;
                             * ordering constraints stay within each group. */}
                            <Suspense fallback={null}>
                              <BootCapabilityRouteActivator />
                            </Suspense>
                            <BootProfileStartupProbe />
                            <DeferredBootInitializers />
                            <ContextKeysInitializer />
                            {/* Drops the right rail's conversation-shaped leftovers
                             * (reveal intents, workspace target, artifact-list
                             * filters) whenever the focused conversation changes. */}
                            <SessionFocusInitializer />
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
                                              {/* Pointer art. After MotionApplier so
                                  the reduce-motion class is already settled
                                  when the effect layer reads it, and before
                                  the color appliers because the "follow the
                                  accent" mode resolves the palette from the
                                  store rather than from the DOM. */}
                                              <CursorApplier />
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
                                                    <SidecarSpanProvider>
                                                      <CompanionBootProvider>
                                                        <WebCompanionBootProvider>
                                                          <DesktopSyncSourceProvider>
                                                            <DesktopMessageSourceProvider>
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
                                                                    <SurfaceAvailabilityBoundary>
                                                                      {children}
                                                                    </SurfaceAvailabilityBoundary>
                                                                  </DesktopAppShell>
                                                                </MobileShellWrapper>
                                                              </div>
                                                            </DesktopMessageSourceProvider>
                                                          </DesktopSyncSourceProvider>
                                                        </WebCompanionBootProvider>
                                                      </CompanionBootProvider>
                                                    </SidecarSpanProvider>
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
                            {/* Sink for diagnostics raised outside React (storage,
                             * Tauri transport, health probes). Resolves the code to
                             * localized text and files it through the notification
                             * center. Additive — it does not intercept the paths
                             * that already surface their own errors. */}
                            <DiagnosticNotifier />
                            {/* Consumer of `pendingReportRequest` — the tray's
                             * "Report issue" and `/report` open the unified
                             * "Report a problem" dialog through here. */}
                            <ReportProblemHost />
                            {/* Global live progress for workflow runs started outside
                             * the editor (library Run button, /workflow chat command,
                             * IM/API). Editor/run-list runs keep their own inline
                             * toasts. */}
                            <WorkflowRunToaster />
                            {/* Thread D4 — bounces sidecar/external-agent orchestration
                             *  calls (agent_dispatch / team_run / plugin_tool_invoke)
                             *  to the renderer entry points. No-op in web. */}
                            <OrchestrationDispatchProvider />
                            <RendererPerfInitializer />
                            {/* Dev-only perf HUD. In production it returns null
                             * unless `localStorage.cogniaPerfHud === "1"`. */}
                            <PerfHud />
                            {/* Floating virtual-pet widget — gates itself on the pet
                             * setting and degrades on mobile / reduced motion. */}
                            <PetMount />
                            {/* Pointer particle/trail overlay — renders null unless
                             * an effect is selected, and stands down under reduced
                             * motion or on a coarse (touch) pointer. */}
                            <CursorEffectLayer />
                            {/* Content-capture confirm bubble + clipboard watcher —
                             * self-gates on the capture setting (disabled by default). */}
                            <CaptureMount />
                            {/* Global TTS "now playing" bar — self-hides when idle. */}
                            <TtsNowPlayingBar />
                            {/* Modal for the agent's `ask_user` tool — self-hides when
                             * no prompt is pending. */}
                            <AskUserDialog />
                            {/* ADR-0106 — mounted at the root, not in the Skills panel:
                            the command palette, the `skills.record` shortcut and
                            `/record-skill` all fire on any route. Renders null
                            unless a recording flow is open. */}
                            <SkillRecorderRoot />
                            {/* Persistent notice when `settings.load()` fell back to
                             * DEFAULTS. Self-hides unless the store's `loadFailed`
                             * flag is set, so it costs one selector in the normal
                             * case. Above <Toaster /> so a transient toast never
                             * paints over a condition that lasts the whole session. */}
                            <SettingsLoadFailedBanner />
                            {/* Residual notice for a first run the user left
                             * early (ADR-0122). Self-hiding — it costs one
                             * selector unless `onboardingProgress.path` records
                             * a deliberate skip. */}
                            <FinishSetupBar />
                            <Toaster />
                            {/* Capacitor-only boot surfaces (splash). Consolidated +
                             * runtime-gated + dynamically imported; the browser/Tauri
                             * dev server never compiles them, the mobile build loads
                             * them at runtime. */}
                            <MobileOnlyInitializers />
                          </OnboardingGate>
                        </RecoveryBootGate>
                      </LoggerProvider>
                    </TooltipProvider>
                  </TauriProvider>
                </SettingsSyncProvider>
              </AccountGate>
            </LocaleGate>
          </LightweightRouteShell>
        </ThemeProvider>
      </body>
    </html>
  )
}
