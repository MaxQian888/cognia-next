/**
 * Runtime lifecycle for plugin-contributed trigger sources.
 *
 * The registry owns definitions and handles; this module projects persisted
 * workflow nodes into exact `(workflowId, triggerId)` live instances. Keeping
 * orchestration here avoids a registry ↔ dispatch circular dependency.
 */

import { listWorkflows } from "@/lib/db/workflows"
import { dispatchPluginTrigger } from "@/lib/plugin/bridge/plugin-trigger-dispatch"
import { recordSilentFailure } from "@/lib/plugin/contracts/diagnostics-store"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import {
  listPluginTriggers,
  pluginTriggerInstanceKey,
  stableParamsSignature,
  startPluginTriggerInstance,
  subscribePluginTriggerRegistry,
  type TriggerInstanceHandle,
  type TriggerRegistration,
} from "./registry"

let registryDisposer: (() => void) | undefined
let reconciliation = Promise.resolve()
let lifecycleEpoch = 0
let lifecycleActive = false
let lifecycleDisposal = Promise.resolve()

interface PendingPluginTriggerStart {
  key: string
  registration: TriggerRegistration
  workflowId: string
  triggerId: string
  paramsSignature: string
  controller: AbortController
  cancelled: boolean
  settled: Promise<void>
}

const pendingStarts = new Map<string, PendingPluginTriggerStart>()

export async function syncPluginTriggerInstances(workflow: VisualWorkflow): Promise<void> {
  const epoch = lifecycleEpoch
  if (!isLifecycleCurrent(epoch)) return
  await lifecycleDisposal
  if (!isLifecycleCurrent(epoch)) return
  await syncPluginTriggerInstancesForEpoch(workflow, epoch)
}

async function syncPluginTriggerInstancesForEpoch(
  workflow: VisualWorkflow,
  epoch: number
): Promise<void> {
  for (const registration of listPluginTriggers()) {
    if (!isLifecycleCurrent(epoch)) return
    await syncRegistrationForWorkflow(registration, workflow, epoch)
  }
}

function isLifecycleCurrent(epoch: number): boolean {
  return lifecycleActive && epoch === lifecycleEpoch
}

async function syncRegistrationForWorkflow(
  registration: TriggerRegistration,
  workflow: VisualWorkflow,
  epoch: number
): Promise<void> {
  const desiredNodes =
    workflow.isTemplate || workflow.isBuiltIn
      ? []
      : workflow.nodes.filter(
          (node) =>
            node.type === registration.kind &&
            node.typeVersion === registration.typeVersion &&
            node.data.disabled !== true
        )
  const desiredById = new Map(desiredNodes.map((node) => [node.id, node]))
  cancelPendingStarts((pending) => {
    if (pending.registration !== registration || pending.workflowId !== workflow.id) return false
    const desired = desiredById.get(pending.triggerId)
    return (
      !desired ||
      stableParamsSignature((desired.data.params ?? {}) as Record<string, unknown>) !==
        pending.paramsSignature
    )
  })
  const existing = [...registration.instances.values()].filter(
    (instance) => instance.workflowId === workflow.id
  )

  await Promise.all(
    existing.map(async (instance) => {
      const desired = desiredById.get(instance.triggerId)
      const desiredSignature = desired
        ? stableParamsSignature((desired.data.params ?? {}) as Record<string, unknown>)
        : undefined
      if (!desired || desiredSignature !== instance.paramsSignature) {
        await stopInstanceSafely(registration, instance, "trigger.stop")
      }
    })
  )

  for (const node of desiredNodes) {
    if (!isLifecycleCurrent(epoch)) return
    const instanceKey = pluginTriggerInstanceKey(workflow.id, node.id)
    const startKey = pendingStartKey(registration, workflow.id, node.id)
    if (registration.instances.has(instanceKey) || pendingStarts.has(startKey)) continue
    await startExactInstance(registration, workflow.id, node, epoch)
  }
}

async function startExactInstance(
  registration: TriggerRegistration,
  workflowId: string,
  node: WorkflowNode,
  epoch: number
): Promise<void> {
  if (!isLifecycleCurrent(epoch)) return
  const controller = new AbortController()
  const params = (node.data.params ?? {}) as Record<string, unknown>
  const key = pendingStartKey(registration, workflowId, node.id)
  const pending: PendingPluginTriggerStart = {
    key,
    registration,
    workflowId,
    triggerId: node.id,
    paramsSignature: stableParamsSignature(params),
    controller,
    cancelled: false,
    settled: Promise.resolve(),
  }
  pendingStarts.set(key, pending)
  pending.settled = runPendingStart(pending, params)
  await pending.settled
}

async function runPendingStart(
  pending: PendingPluginTriggerStart,
  params: Record<string, unknown>
): Promise<void> {
  const { registration, workflowId, triggerId, controller, key } = pending
  try {
    const instance = await startPluginTriggerInstance(registration.kind, registration.typeVersion, {
      workflowId,
      triggerId,
      params,
      emit: (payload) => {
        void dispatchPluginTrigger({
          pluginId: registration.pluginId,
          workflowId,
          kind: registration.def.kind,
          triggerId,
          payload,
        })
      },
      signal: controller.signal,
      logger: pluginTriggerLogger(registration),
    })
    if (!instance) return
    if (pending.cancelled || controller.signal.aborted || pendingStarts.get(key) !== pending) {
      await stopInstanceSafely(registration, instance, "trigger.stop")
      return
    }
    const stopInstance = instance.stop.bind(instance)
    instance.stop = async () => {
      controller.abort()
      await stopInstance()
    }
  } catch (error) {
    const expectedCancellation = pending.cancelled || controller.signal.aborted
    controller.abort()
    if (!expectedCancellation) {
      recordSilentFailure(
        registration.pluginId,
        {
          site: "trigger.start",
          message: `Plugin trigger ${registration.kind}@${registration.typeVersion} failed to start for ${workflowId}/${triggerId}`,
          expected: false,
        },
        error
      )
    }
  } finally {
    if (pendingStarts.get(key) === pending) pendingStarts.delete(key)
  }
}

function pendingStartKey(
  registration: TriggerRegistration,
  workflowId: string,
  triggerId: string
): string {
  return `${registration.kind}@${registration.typeVersion}::${workflowId}::${triggerId}`
}

function cancelPendingStarts(predicate: (pending: PendingPluginTriggerStart) => boolean): void {
  const cancelled = [...pendingStarts.values()].filter(predicate)
  for (const pending of cancelled) {
    pending.cancelled = true
    pending.controller.abort()
    if (pendingStarts.get(pending.key) === pending) pendingStarts.delete(pending.key)
  }
}

function pluginTriggerLogger(registration: TriggerRegistration) {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, data?: unknown): void => {
      const method =
        level === "error"
          ? console.error
          : level === "warn"
            ? console.warn
            : level === "info"
              ? console.info
              : console.debug
      method(`[plugin:${registration.pluginId}][${registration.kind}] ${message}`, data)
    }
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  }
}

async function stopInstanceSafely(
  registration: TriggerRegistration,
  instance: TriggerInstanceHandle,
  site: string
): Promise<void> {
  try {
    await instance.stop()
  } catch (error) {
    recordSilentFailure(
      registration.pluginId,
      {
        site,
        message: `Plugin trigger ${registration.kind}@${registration.typeVersion} failed to stop for ${instance.workflowId}/${instance.triggerId}`,
        expected: false,
      },
      error
    )
  }
}

export async function unsyncPluginTriggerInstances(workflow: VisualWorkflow): Promise<void> {
  cancelPendingStarts((pending) => pending.workflowId === workflow.id)
  await Promise.all(
    listPluginTriggers().flatMap((registration) =>
      [...registration.instances.values()]
        .filter((instance) => instance.workflowId === workflow.id)
        .map((instance) => stopInstanceSafely(registration, instance, "trigger.stop"))
    )
  )
}

/**
 * Reconcile workflows when a plugin registers after the initial workflow
 * startup sweep. Idempotent and serialized to avoid duplicate source starts.
 */
export function initPluginTriggerLifecycle(): void {
  registryDisposer?.()
  lifecycleEpoch += 1
  lifecycleActive = true
  const epoch = lifecycleEpoch
  const abandonedReconciliation = reconciliation
  reconciliation = Promise.resolve()
  void abandonedReconciliation.catch((error) => {
    console.warn("Plugin trigger reconciliation failed during reinitialisation:", error)
  })
  registryDisposer = subscribePluginTriggerRegistry((event) => {
    if (event.type === "unregister") {
      cancelPendingStarts(
        (pending) =>
          pending.registration.kind === event.kind &&
          pending.registration.typeVersion === event.typeVersion &&
          pending.registration.pluginId === event.pluginId
      )
      return
    }
    if (event.type !== "register") return
    reconciliation = reconciliation
      .then(async () => {
        if (!isLifecycleCurrent(epoch)) return
        const workflows = await listWorkflows()
        if (!isLifecycleCurrent(epoch)) return
        await lifecycleDisposal
        if (!isLifecycleCurrent(epoch)) return
        for (const workflow of workflows) {
          await syncPluginTriggerInstancesForEpoch(workflow, epoch)
        }
      })
      .catch((error) => {
        console.warn("Plugin trigger reconciliation failed:", error)
      })
  })
}

export async function disposePluginTriggerLifecycle(): Promise<void> {
  lifecycleActive = false
  lifecycleEpoch += 1
  registryDisposer?.()
  registryDisposer = undefined
  const abandonedReconciliation = reconciliation
  reconciliation = Promise.resolve()
  void abandonedReconciliation.catch((error) => {
    console.warn("Plugin trigger reconciliation failed during disposal:", error)
  })
  cancelPendingStarts(() => true)
  const instances = listPluginTriggers().flatMap((registration) =>
    [...registration.instances.values()].map((instance) => ({ registration, instance }))
  )
  const disposal = Promise.all(
    instances.map(({ registration, instance }) =>
      stopInstanceSafely(registration, instance, "trigger.stop")
    )
  ).then(() => undefined)
  lifecycleDisposal = disposal
  await disposal
}

/** Test-only drain for the queued late-registration reconciliation. */
export async function _waitForPluginTriggerReconciliationForTest(): Promise<void> {
  await reconciliation
}
