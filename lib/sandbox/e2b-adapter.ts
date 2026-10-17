/** ADR-0233: one Host-bound E2B lifecycle adapter; no local GUI fallback. */
import {
  managedDesktopClient,
  type ManagedDesktopClient,
  type ManagedDesktopCreation,
  type ManagedDesktopResource,
} from "@/lib/automation/managed-desktop-client"
import type { SandboxConnectionRow, SandboxLifecycleState } from "@/types/sandbox"
import {
  SandboxCapabilityError,
  type SandboxAdapterOutcome,
  type SandboxProviderAdapter,
} from "./lifecycle-contract"

import { hasCurrentManagedDesktopQualification } from "./connection-capabilities"

export interface ManagedDesktopAdapterOptions {
  managedClient?: ManagedDesktopClient
  /** Single-use authorization issued by the owning Host after human consent. Never persisted in the row. */
  managedCreation?: ManagedDesktopCreation
}

export function managedDesktopLifecycleState(
  state: ManagedDesktopResource["state"]
): SandboxLifecycleState {
  switch (state) {
    case "destroyRetrying":
      return "deleting"
    case "destroyed":
      return "uninitialized"
    default:
      return state
  }
}

export function buildE2bSandboxAdapter(
  row: SandboxConnectionRow,
  outcome: SandboxAdapterOutcome,
  options: ManagedDesktopAdapterOptions = {}
): SandboxProviderAdapter {
  if (row.config.provider !== "e2b") throw new Error("E2B adapter requires its own configuration")
  const config = row.config
  const api = options.managedClient ?? managedDesktopClient
  const reference = () => {
    if (!config.desktopId || !Number.isSafeInteger(config.generation) || config.generation! < 1) {
      throw new SandboxCapabilityError({
        code: "not-connected",
        operation: "connect",
        provider: "e2b",
        driver: row.driver,
      })
    }
    return { desktopId: config.desktopId, generation: config.generation! }
  }
  return {
    provider: "e2b",
    driver: "computer-server",
    create: async () => {
      if (!hasCurrentManagedDesktopQualification(config))
        throw new SandboxCapabilityError({
          code: "provider-unqualified",
          operation: "create",
          provider: "e2b",
          driver: row.driver,
        })
      const request = options.managedCreation
      if (
        !request ||
        request.providerConfigId !== config.providerConfigId ||
        !request.authorizationId ||
        !request.quoteId ||
        !request.idempotencyKey
      ) {
        throw new SandboxCapabilityError({
          code: "authorization-required",
          operation: "create",
          provider: "e2b",
          driver: row.driver,
        })
      }
      outcome.managedDesktop = await api.create(config.target, request)
    },
    connect: async () => {
      outcome.managedDesktop = await api.connect(config.target, reference())
    },
    delete: async () => {
      outcome.managedDesktop = await api.delete(config.target, reference())
    },
    health: async () => {
      const report = await api.health(config.target, reference())
      outcome.managedDesktop = report.desktop
      outcome.health = report.reachable
      return {
        reachable: report.reachable,
        state: managedDesktopLifecycleState(report.state),
        ...(report.errorCode ? { error: report.errorCode } : {}),
      }
    },
  }
}
