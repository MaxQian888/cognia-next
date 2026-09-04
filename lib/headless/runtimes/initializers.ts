/**
 * Headless registrations for the boot initializers (ADR-0059 T-A7..A10).
 *
 * Each entry mirrors one provider/initializer effect body 1:1 — the desktop
 * components keep their own effects (thin, unchanged); the brain starts the
 * same lib calls here. Deliberately NOT included:
 *
 * - `initDesktopEventTrigger` (workflow runtime) — the desktop UIA watcher
 *   does not exist in cognia-server. (`installTriggerBridge` now rides the
 *   events WS — see ./workflow-trigger-bridge.ts.)
 * - `subscription-initializer` — keyed to the interactive account unlock and
 *   uses toast i18n; the brain's provider creds arrive via the `claude_set_*`
 *   arms instead (R7).
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
      { resolveWorkflowDeployment },
      { syncWorkflowTriggers, unsyncWorkflowTriggers },
      { resumeInFlightRuns },
      { initPluginTriggerLifecycle, disposePluginTriggerLifecycle },
      { reconcilePendingGoalVerifications },
      { registerScheduleHandoffDelivery },
      { installHostDispatchRuntime },
      { registerThreadHandoffDelivery },
    ] = await Promise.all([
      import("@/lib/workflow/runtime/trigger-subscriptions"),
      import("@/lib/db/workflows"),
      import("@/lib/db/workflow-deployments"),
      import("@/lib/workflow/runtime/webhook-bridge"),
      import("@/lib/workflow/runtime/resume-controller"),
      import("@/lib/workflow/triggers/lifecycle"),
      import("@/lib/goal/verification"),
      import("@/lib/workflow/runtime/schedule-handoff-delivery"),
      import("@/lib/placement/host-dispatch-runtime"),
      import("@/lib/thread-handoff/delivery"),
    ])

    const unregisterScheduleHandoff = registerScheduleHandoffDelivery()
    const unregisterThreadHandoff = registerThreadHandoffDelivery()
    const hostDispatchRuntime = installHostDispatchRuntime({ accountId: ctx.localAccountId })
    initTriggerSubscriptions()
    initPluginTriggerLifecycle()
    try {
      const all = await listWorkflows()
      await Promise.allSettled(
        all.map(async (workflow) => {
          const deployed = await resolveWorkflowDeployment(workflow.id)
          if (deployed) await syncWorkflowTriggers(deployed.workflow)
          else await unsyncWorkflowTriggers(workflow)
        })
      )
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
    await reconcilePendingGoalVerifications().catch((error) =>
      ctx.log(
        "warn",
        `goal verification reconcile failed: ${error instanceof Error ? error.message : String(error)}`
      )
    )
    return async () => {
      disposeTriggerSubscriptions()
      await disposePluginTriggerLifecycle()
      await hostDispatchRuntime.stop()
      unregisterScheduleHandoff()
      unregisterThreadHandoff()
    }
  },
})

// ── Workflow run lease handoff on graceful brain shutdown ─────────────────

registerHeadlessRuntime({
  name: "workflow-exit-lease-release",
  hosts: ["brain"],
  start: async () => {
    const { installExitLeaseRelease, releaseHeldLeasesForExit } =
      await import("@/lib/workflow/runtime/exit-lease-release")
    // The installer owns pagehide/Tauri close events on desktop. In Node it is
    // intentionally inert; `serveCommand` turns SIGINT/SIGTERM into the
    // registry teardown below, which is the brain's equivalent lifecycle seam.
    const disposeDesktopSignals =
      typeof window !== "undefined" && typeof window.addEventListener === "function"
        ? installExitLeaseRelease()
        : () => undefined
    return async () => {
      disposeDesktopSignals()
      await releaseHeldLeasesForExit()
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

// ── A10: external-agent rehydrate (acp-client routes via the transport seam) ─

registerHeadlessRuntime({
  name: "external-agent",
  hosts: ["brain"],
  start: async () => {
    const [
      { startExternalAgentRehydration },
      { setAcpDynamicMcpHostController },
      { createAcpDynamicMcpHostController },
    ] = await Promise.all([
      import("@/lib/ai/agent/external/rehydrate"),
      import("@/lib/ai/agent/external/acp-client"),
      import("@/lib/ai/agent/external/acp-dynamic-mcp-controller"),
    ])
    setAcpDynamicMcpHostController(createAcpDynamicMcpHostController())
    const stopRehydration = startExternalAgentRehydration()
    return async () => {
      setAcpDynamicMcpHostController(undefined)
      await stopRehydration?.()
    }
  },
})

// ── Server OCR provider registry ───────────────────────────────────────────

registerHeadlessRuntime({
  name: "ocr-runtime",
  hosts: ["brain"],
  start: async () => {
    const [{ installOcrRuntime, __resetOcrRuntime }, { __resetSharedOcrRegistry }] =
      await Promise.all([import("@/lib/ocr/runtime"), import("@/lib/ocr/registry")])
    await installOcrRuntime()
    return () => {
      __resetOcrRuntime()
      __resetSharedOcrRegistry()
    }
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

registerHeadlessRuntime({
  name: "template-trust-reconciliation",
  hosts: ["brain"],
  start: async () => {
    const { getTemplateRuntime } = await import("@/lib/templates/runtime")
    await getTemplateRuntime().service.hydrateCatalog()
  },
})

// ── Host network transport for the adapter-based packages ──────────────────
//
// Same seam the desktop mounts via `DesktopNetworkRuntimeInitializer`. The
// brain is not a WebView and has no CSP, so `proxyFetch` degrades to the
// platform `fetch` here — but leaving the adapters uninstalled would also
// leave `@cognia/rag` logging into a void, and a host that installs the seam
// on one shell and not the other is exactly the drift this registry exists to
// prevent.

registerHeadlessRuntime({
  name: "desktop-network-runtime",
  hosts: ["brain"],
  start: async () => {
    const { installDesktopNetworkRuntime, __resetDesktopNetworkRuntime } =
      await import("@/lib/network/desktop-network-runtime")
    installDesktopNetworkRuntime()
    return () => __resetDesktopNetworkRuntime()
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
    const [{ interruptRendererBackgroundTasksOnBoot }, { recoverStaleDirectChatExecutionRuns }] =
      await Promise.all([
        import("@/lib/background-tasks/renderer-subagent-registry"),
        import("@/lib/execution/direct-chat-run"),
      ])
    await Promise.all([
      interruptRendererBackgroundTasksOnBoot(),
      recoverStaleDirectChatExecutionRuns(),
    ])
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

// ── ADR-0123: durable work submission recovery ──────────────────────────────
//
// The brain previously had NO stranded-run reconciliation: the renderer mounts
// `recoverStaleDirectChatExecutionRuns` in two initializers, and nothing
// mirrored it here. A headless host that died mid-turn left its work untouched.

registerHeadlessRuntime({
  name: "work-submission-outbox",
  hosts: ["brain"],
  start: async () => {
    const { startHeadlessWorkOutbox } = await import("@/lib/work-submission/bootstrap")
    return startHeadlessWorkOutbox()
  },
})
