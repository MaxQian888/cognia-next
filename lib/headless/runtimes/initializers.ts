/**
 * Headless registrations for the boot initializers (ADR-0059 T-A7..A9).
 *
 * Each entry mirrors one provider/initializer effect body 1:1 — the desktop
 * components keep their own effects (thin, unchanged); the brain starts the
 * same lib calls here. Deliberately NOT included:
 *
 * - `installTriggerBridge` / `initDesktopEventTrigger` (workflow runtime) —
 *   Tauri-event sources; the Rust cron daemon / desktop UIA watcher do not
 *   exist in cognia-server yet (follow-up rides the events WS).
 * - `subscription-initializer` — keyed to the interactive account unlock and
 *   uses toast i18n; the brain's provider creds arrive via the `claude_set_*`
 *   arms instead (R7).
 * - `external-agent-initializer` — rehydrates the RENDERER-side manager; the
 *   brain drives agents through the service-scope RPC arms (R11) until
 *   T-A10 reroutes acp-client through the transport seam.
 */
import { registerHeadlessRuntime } from "../registry"

// ── A7: scheduler ───────────────────────────────────────────────────────────

registerHeadlessRuntime({
  name: "scheduler",
  hosts: ["brain"],
  start: async (ctx) => {
    const [{ useSchedulerStore }, { stopSchedulerSystem }, { installExecutionEventBridge }] =
      await Promise.all([
        import("@/stores/scheduler"),
        import("@/lib/scheduler"),
        import("@/lib/execution/event-bridge"),
      ])
    const teardownBridge = installExecutionEventBridge()
    try {
      await useSchedulerStore.getState().initialize()
      useSchedulerStore.getState().setSchedulerStatus("running")
    } catch (error) {
      ctx.log(
        "error",
        `scheduler initialize failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return () => {
      teardownBridge()
      stopSchedulerSystem()
      useSchedulerStore.getState().setSchedulerStatus("stopped")
    }
  },
})

// ── A7: workflow runtime (TS-hook triggers + trigger sync + resume) ─────────

registerHeadlessRuntime({
  name: "workflow-runtime",
  hosts: ["brain"],
  start: async (ctx) => {
    const [
      { initTriggerSubscriptions, disposeTriggerSubscriptions },
      { listWorkflows },
      { syncWorkflowTriggers },
      { resumeInFlightRuns },
      { initPluginTriggerLifecycle, disposePluginTriggerLifecycle },
    ] = await Promise.all([
      import("@/lib/workflow/runtime/trigger-subscriptions"),
      import("@/lib/db/workflows"),
      import("@/lib/workflow/runtime/webhook-bridge"),
      import("@/lib/workflow/runtime/resume-controller"),
      import("@/lib/workflow/triggers/lifecycle"),
    ])

    initTriggerSubscriptions()
    initPluginTriggerLifecycle()
    try {
      const all = await listWorkflows()
      await Promise.allSettled(all.map((workflow) => syncWorkflowTriggers(workflow)))
    } catch (error) {
      ctx.log(
        "warn",
        `workflow trigger sync failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    try {
      await resumeInFlightRuns()
    } catch (error) {
      ctx.log(
        "warn",
        `workflow resume failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return async () => {
      disposeTriggerSubscriptions()
      await disposePluginTriggerLifecycle()
    }
  },
})

// ── A9: agent team runtime deps ─────────────────────────────────────────────

registerHeadlessRuntime({
  name: "agent-team-runtime",
  hosts: ["brain"],
  start: async () => {
    const [{ configureAgentTeamRuntime }, { buildAgentTeamRuntimeDeps }] = await Promise.all([
      import("@/lib/ai/agent/agent-team"),
      import("@/lib/ai/agent/agent-team-runtime-deps"),
    ])
    configureAgentTeamRuntime(buildAgentTeamRuntimeDeps())
  },
})

// ── A9: automation policy hydration ─────────────────────────────────────────

registerHeadlessRuntime({
  name: "automation-policy",
  hosts: ["brain"],
  start: async () => {
    const { hydrateAutomationPolicy } = await import("@/lib/automation/policy")
    await hydrateAutomationPolicy()
  },
})

// ── A9: retention sweepers ──────────────────────────────────────────────────

registerHeadlessRuntime({
  name: "audit-retention",
  hosts: ["brain"],
  start: async () => {
    const { startAuditRetentionSweeper } = await import("@/lib/automation/audit-retention")
    return startAuditRetentionSweeper()
  },
})

registerHeadlessRuntime({
  name: "storage-retention",
  hosts: ["brain"],
  start: async () => {
    const { startStorageRetentionSweeper } = await import("@/lib/storage/retention")
    return startStorageRetentionSweeper()
  },
})

// ── A9: provider-core runtime adapters ──────────────────────────────────────

registerHeadlessRuntime({
  name: "provider-core-runtime",
  hosts: ["brain"],
  start: async () => {
    const [{ setProviderCoreRuntimeAdapters }, { buildProviderCoreRuntimeAdapters }] =
      await Promise.all([
        import("@cognia/provider-core/providers/runtime-adapters"),
        import("@/lib/ai/provider-core-runtime-deps"),
      ])
    setProviderCoreRuntimeAdapters(buildProviderCoreRuntimeAdapters())
  },
})

// ── A9: provider routing runtime adapters ───────────────────────────────────

registerHeadlessRuntime({
  name: "routing-runtime",
  hosts: ["brain"],
  start: async () => {
    const [{ setProviderRoutingRuntimeAdapters }, { buildRoutingRuntimeAdapters }] =
      await Promise.all([
        import("@cognia/provider-routing/runtime-adapters"),
        import("@/lib/claude/routing-runtime-deps"),
      ])
    setProviderRoutingRuntimeAdapters(buildRoutingRuntimeAdapters())
  },
})

// ── A9: crash-recovery + cost housekeeping ──────────────────────────────────

registerHeadlessRuntime({
  name: "background-task",
  hosts: ["brain"],
  start: async () => {
    const { interruptRendererBackgroundTasksOnBoot } =
      await import("@/lib/background-tasks/renderer-subagent-registry")
    await interruptRendererBackgroundTasksOnBoot()
  },
})

registerHeadlessRuntime({
  name: "provider-cost-mirror",
  hosts: ["brain"],
  start: async () => {
    const RETENTION_DAYS = 90
    const [{ getTodaysCostByProvider, localDayString, pruneProviderCostOlderThan }, usage, store] =
      await Promise.all([
        import("@/lib/db/provider-cost-daily"),
        import("@/lib/db/session-usage"),
        import("@/stores/settings/provider-cost-mirror-store"),
      ])
    // Same best-effort semantics as the desktop initializer.
    await getTodaysCostByProvider()
      .then((totals) =>
        store.useProviderCostMirrorStore.getState().hydrate(totals, localDayString())
      )
      .catch(() => {})
    await pruneProviderCostOlderThan(RETENTION_DAYS).catch(() => {})
    await usage.pruneSessionUsageOlderThan(RETENTION_DAYS).catch(() => {})
  },
})
