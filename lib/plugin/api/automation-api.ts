/**
 * Plugin Automation API (`ctx.automation`) — drives the real desktop through
 * the Computer Use surface (ADR-0020). Wraps the `lib/automation/client.ts`
 * `desktop.*` command set, tagging every call with `surface: "plugin"` + the
 * plugin id so the Rust per-surface permission gate (tier / whitelist /
 * per-call consent overlay) fires for the plugin surface.
 *
 * TWO gates stack here:
 *   1. The TS PermissionGuard (`createGuardedAPI`) — the plugin must declare
 *      the matching `automation:*` manifest permission, or the call throws.
 *   2. The Rust automation policy — even with the manifest permission, the
 *      host's per-plugin tier / whitelist / per-call consent still applies,
 *      the global kill-switch hard-stops everything, and `enabled: false`
 *      keeps the whole surface off. The plugin never sees the host's settings.
 *
 * Deliberately exposes ONLY the action surface. Host-admin operations
 * (settings get/set, kill-switch, consent respond, virtual-display setup,
 * audit snapshot) are NOT exposed — a plugin must not reconfigure or disarm
 * the user's automation guardrails (parity with `ctx.perf` omitting sampler
 * control). Every permission here is classified DANGEROUS.
 *
 * Desktop-only: on web / mobile the underlying transport rejects with
 * UNSUPPORTED_PLATFORM.
 */

import { desktop, type CallContext } from "@/lib/automation/client"
import { useChatStore } from "@/stores/chat"
import { getActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
import { captureScreenshot } from "@/lib/ui/screenshot"
import {
  HOST_FALLBACK_RUNTIME_REF,
  sandboxSessionRuntime,
  type SandboxRuntimeRef,
} from "@/lib/sandbox/session-runtime"
import { clickScreenText, findScreenText } from "@/lib/automation/ocr-click"
import {
  withComputerUsePipActivity as withPipActivity,
  publishComputerUsePipFrame,
  suppressComputerUsePipForCapture,
  setComputerUsePipTarget,
} from "@/lib/automation/computer-use-pip"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type {
  PluginAutomationAPI,
  PluginComputerUseOrigin,
} from "@cognia/plugin-contract/lib/plugin/api/automation-api"
export type {
  PluginAutomationAPI,
  PluginComputerUseOrigin,
} from "@cognia/plugin-contract/lib/plugin/api/automation-api"

interface AutomationRuntime {
  desktop: typeof desktop
  captureDisplay: typeof captureScreenshot
  getComputerUseSettings: typeof getActiveComputerUseSettings
  /** Focused chat session, used ONLY to scope consent — never placement. */
  focusedSessionId: () => string | undefined
  sandbox: Pick<
    typeof sandboxSessionRuntime,
    "activeRefForSession" | "decorateComputerUseContext"
  > & { hostFallbackRuntimeRef: SandboxRuntimeRef }
}

const defaultAutomationRuntime: AutomationRuntime = {
  desktop,
  captureDisplay: captureScreenshot,
  getComputerUseSettings: getActiveComputerUseSettings,
  focusedSessionId: () => useChatStore.getState().activeSessionId ?? undefined,
  sandbox: {
    hostFallbackRuntimeRef: HOST_FALLBACK_RUNTIME_REF,
    activeRefForSession: (sessionId) => sandboxSessionRuntime.activeRefForSession(sessionId),
    decorateComputerUseContext: (ref, base) =>
      sandboxSessionRuntime.decorateComputerUseContext(ref, base),
  },
}

async function buildComputerUseCallContext(
  pluginId: string,
  origin: PluginComputerUseOrigin | undefined,
  runtime: AutomationRuntime,
  fallbackScope?: { sessionId: string | undefined }
): Promise<CallContext> {
  const context: CallContext = { surface: "computerUse", pluginId }
  // Consent scoping falls back to the focused session when the caller has no
  // session of its own (workflow node, plan step, External Bridge, a
  // plugin-to-plugin call). Without the fallback a character configured with
  // `requireConsent: true` silently loses the per-call overlay for exactly
  // those callers, because `forceTier` is only ever set from a session id.
  const focusedSessionId = runtime.focusedSessionId()
  const consentSessionId =
    origin?.sessionId ?? (fallbackScope ? fallbackScope.sessionId : focusedSessionId)
  if (consentSessionId) {
    context.sessionKey = consentSessionId
    // A plugin-provided session id is provenance, not authority: it may not be
    // used to LOWER the tier, so the focused session's stricter setting still
    // applies when the two disagree. It must not RAISE the tier either.
    // Treating the mere presence of an origin as a consent demand upgrades
    // every `Decision::Allow` to `RequireConsent`, which puts an approval
    // overlay in front of every step of a chat-driven run and makes the
    // Whitelist / Off tiers unreachable. Only `requireConsent` decides.
    if (
      runtime.getComputerUseSettings(consentSessionId)?.requireConsent === true ||
      (focusedSessionId !== consentSessionId &&
        runtime.getComputerUseSettings(focusedSessionId)?.requireConsent === true)
    ) {
      context.forceTier = "perCall"
    }
  }
  if (origin?.messageId) context.turnKey = origin.messageId

  // Placement deliberately does NOT take the focused-session fallback: it is
  // fine for scoping consent, but here it would borrow another conversation's
  // binding and drive the operator's own desktop for a session bound to a
  // remote target. Callers with no session keep the host/local placement.
  // The send's own immutable binding wins; the session's current binding is
  // the recovery for a ref that did not survive the hop (the CLI rail).
  const runtimeRef =
    origin?.sandboxRuntimeRef ??
    runtime.sandbox.activeRefForSession(origin?.sessionId) ??
    runtime.sandbox.hostFallbackRuntimeRef
  return runtime.sandbox.decorateComputerUseContext(runtimeRef, context)
}

/** Push a captured frame to the live view, skipping withheld (deduped) ones. */
function publishFrame(
  sessionKey: string | undefined,
  screenshot: {
    bytes: string
    width: number
    height: number
    capturedAt?: number
    format?: "png" | "jpeg"
  } | null,
  activityId: number | null,
  targetConnectionId: string | null = null
): void {
  if (!screenshot?.bytes) return
  publishComputerUsePipFrame(
    sessionKey,
    {
      output: screenshot.bytes,
      width: screenshot.width,
      height: screenshot.height,
      capturedAt: screenshot.capturedAt,
      format: screenshot.format,
      targetConnectionId,
    },
    activityId
  )
}

/** Create a permission-gated plugin API with run-scoped operator feedback. */
export function createAutomationAPI(
  pluginId: string,
  runtime: AutomationRuntime = defaultAutomationRuntime
): PluginAutomationAPI {
  // The plugin never supplies the call context — we always stamp the plugin
  // surface + id so it can neither impersonate another surface nor drop its id.
  const ctx = { surface: "plugin", pluginId } as const
  const legacyActivity = <T>(action: string, run: () => Promise<T>) =>
    withPipActivity(runtime.focusedSessionId(), action, run, null)

  const appActivity = <T>(
    action: string,
    origin: PluginComputerUseOrigin | undefined,
    run: (context: CallContext, activityId: number | null) => Promise<T>,
    appSessionId = "desktop",
    label?: string
  ) => {
    const sessionKey = origin?.sessionId ?? runtime.focusedSessionId()
    const runtimeRef =
      origin?.sandboxRuntimeRef ??
      runtime.sandbox.activeRefForSession(origin?.sessionId) ??
      runtime.sandbox.hostFallbackRuntimeRef
    return withPipActivity(
      sessionKey,
      action,
      async (activityId) => {
        const context = await buildComputerUseCallContext(
          pluginId,
          { ...origin, sandboxRuntimeRef: runtimeRef },
          runtime,
          { sessionId: sessionKey }
        )
        setComputerUsePipTarget(sessionKey, activityId, context.sandboxConnectionId ?? null)
        return run(context, activityId)
      },
      undefined,
      { id: JSON.stringify([pluginId, appSessionId, runtimeRef]), label }
    )
  }

  const api: PluginAutomationAPI = {
    // read
    capabilities: () => runtime.desktop.capabilities(),
    getFocus: () => runtime.desktop.getFocus(ctx),
    readTree: (root = null, opts = {}) => runtime.desktop.readTree(root, opts, ctx),
    find: (locator) => runtime.desktop.find(locator, ctx),
    cursorPosition: () => runtime.desktop.cursorPosition(ctx),
    pickAtPoint: (point) => runtime.desktop.pickAtPoint(point, ctx),
    // screenshot
    screenshot: (opts = {}) => {
      const sessionKey = runtime.focusedSessionId()
      return withPipActivity(
        sessionKey,
        "screenshot",
        async (activityId) => {
          const release = await suppressComputerUsePipForCapture(sessionKey, "local-desktop")
          try {
            const screenshot = await runtime.desktop.screenshot(opts, ctx)
            publishFrame(sessionKey, screenshot, activityId)
            return screenshot
          } finally {
            release()
          }
        },
        null
      )
    },
    captureDisplay: () => runtime.captureDisplay(),
    listApps: async (origin) =>
      runtime.desktop.listApps(await buildComputerUseCallContext(pluginId, origin, runtime)),
    getAppState: (sessionId, locator, options = {}, origin) =>
      appActivity(
        "get_app_state",
        origin,
        async (callCtx, activityId) => {
          const release = await suppressComputerUsePipForCapture(
            callCtx.sessionKey,
            callCtx.sandboxConnectionId ? "none" : "local-desktop"
          )
          let revision
          try {
            revision = await runtime.desktop.getAppState(sessionId, locator, options, callCtx)
          } finally {
            release()
          }
          publishFrame(
            callCtx.sessionKey,
            revision.screenshot,
            activityId,
            callCtx.sandboxConnectionId ?? null
          )
          return revision
        },
        sessionId,
        locator.kind === "displayName"
          ? locator.displayName
          : locator.kind === "bundleId"
            ? locator.bundleId
            : locator.kind === "path"
              ? locator.path.split("/").at(-1)
              : undefined
      ),
    queryElements: async (state, locator, limit = 100, origin) =>
      runtime.desktop.queryElements(
        state,
        locator,
        limit,
        await buildComputerUseCallContext(pluginId, origin, runtime)
      ),
    findText: (args, origin) =>
      appActivity(
        "find_text",
        origin,
        (ctx, activityId) => findScreenText({ ...args, ctx }, activityId),
        args.state?.sessionId
      ),
    clickText: (args, origin) =>
      appActivity(
        "click_text",
        origin,
        (ctx, activityId) => clickScreenText({ ...args, ctx }, activityId),
        args.state?.sessionId
      ),
    zoom: (state, region, origin) =>
      appActivity(
        "zoom",
        origin,
        async (callCtx, activityId) => {
          const zoomed = await runtime.desktop.zoom(state, region, callCtx)
          publishFrame(
            callCtx.sessionKey,
            zoomed.screenshot,
            activityId,
            callCtx.sandboxConnectionId ?? null
          )
          return zoomed
        },
        state.sessionId
      ),
    expandElement: async (handle, continuationToken = null, limit = 250, origin) =>
      runtime.desktop.expandElement(
        handle,
        continuationToken,
        limit,
        await buildComputerUseCallContext(pluginId, origin, runtime)
      ),
    performAction: (request, origin) =>
      appActivity(
        "perform_action",
        origin,
        (ctx) => runtime.desktop.performAction(request, ctx),
        request.target?.kind === "element"
          ? request.target.handle.sessionId
          : request.target?.kind === "pixel"
            ? request.target.target.sessionId
            : undefined
      ),
    // click
    click: (target, opts = {}) =>
      legacyActivity("left_click", () => runtime.desktop.click(target, opts, ctx)),
    mouseButton: (button, transition) =>
      legacyActivity(transition === "down" ? "left_mouse_down" : "left_mouse_up", () =>
        runtime.desktop.mouseButton(button, transition, ctx)
      ),
    // type
    type: (text, opts = {}) => legacyActivity("type", () => runtime.desktop.type(text, opts, ctx)),
    paste: (text) => legacyActivity("type", () => runtime.desktop.paste(text, ctx)),
    keys: (chord) => legacyActivity("key", () => runtime.desktop.keys(chord, ctx)),
    holdKey: (chord, durationMs) =>
      legacyActivity("hold_key", () => runtime.desktop.holdKey(chord, durationMs, ctx)),
    // pointer
    mouseMove: (point) => legacyActivity("mouse_move", () => runtime.desktop.mouseMove(point, ctx)),
    drag: (from, to, opts = {}) =>
      legacyActivity("left_click_drag", () => runtime.desktop.drag(from, to, opts, ctx)),
    scroll: (target, opts = {}) =>
      legacyActivity("scroll", () => runtime.desktop.scroll(target, opts, ctx)),
    // window
    windowOp: (target, op) =>
      legacyActivity("perform_action", () => runtime.desktop.windowOp(target, op, ctx)),
    launchApp: (app, action) =>
      legacyActivity("perform_action", () => runtime.desktop.launchApp(app, action, ctx)),
  }

  return createGuardedAPI(pluginId, api, {
    capabilities: "automation:read",
    getFocus: "automation:read",
    readTree: "automation:read",
    find: "automation:read",
    cursorPosition: "automation:read",
    pickAtPoint: "automation:read",
    screenshot: "automation:screenshot",
    captureDisplay: "automation:screenshot",
    listApps: "automation:read",
    getAppState: ["automation:read", "automation:screenshot"],
    queryElements: "automation:read",
    // A zoom hands back screen pixels, so it needs the screenshot permission
    // even though it only re-crops a frame the caller has already been shown.
    zoom: ["automation:read", "automation:screenshot"],
    findText: ["automation:read", "automation:screenshot"],
    clickText: ["automation:read", "automation:screenshot", "automation:click"],
    expandElement: "automation:read",
    performAction: [
      "automation:click",
      "automation:type",
      "automation:pointer",
      "automation:window",
    ],
    click: "automation:click",
    mouseButton: "automation:click",
    type: "automation:type",
    paste: "automation:type",
    keys: "automation:type",
    holdKey: "automation:type",
    mouseMove: "automation:pointer",
    drag: "automation:pointer",
    scroll: "automation:pointer",
    windowOp: "automation:window",
    launchApp: "automation:window",
  })
}
