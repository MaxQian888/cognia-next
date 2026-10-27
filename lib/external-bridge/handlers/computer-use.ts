/**
 * External Bridge adapter for the canonical app-session Computer Use API.
 *
 * This module deliberately performs no action translation or coordinate
 * conversion. Both renderer and sidecar paths forward the same revision-bound
 * request shapes to `cognia-automation`.
 */

import { desktop, type CallContext } from "@/lib/automation/client"
import type {
  ActionRequest,
  AppLocator,
  ElementHandle,
  GetAppStateOptions,
  Locator,
  Rect,
} from "@/lib/automation/types"
import { isTauri } from "@/lib/tauri"
import { computerUse as proxyComputerUse } from "./computer-use-proxy"

export type ComputerUseInput =
  | { operation: "listApps" }
  | {
      operation: "getAppState"
      turnKey: string
      sessionId: string
      locator: AppLocator
      options?: GetAppStateOptions
    }
  | {
      operation: "queryElements"
      sessionId: string
      lineageId: string
      revision: number
      locator: Locator
      limit?: number
    }
  | {
      operation: "expandElement"
      handle: ElementHandle
      continuationToken?: string | null
      limit?: number
    }
  | {
      operation: "performAction"
      turnKey: string
      request: ActionRequest
    }
  | {
      operation: "zoom"
      sessionId: string
      lineageId: string
      revision: number
      region: Rect
    }

export interface ComputerUseOutput {
  ok: boolean
  result?: unknown
  error?: string
}

export async function computerUse(input: ComputerUseInput): Promise<ComputerUseOutput> {
  if (!isTauri()) return proxyComputerUse(input)
  try {
    const result = await rendererPath(input)
    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function context(turnKey?: string): CallContext {
  return { surface: "mcp", turnKey }
}

async function rendererPath(input: ComputerUseInput): Promise<unknown> {
  switch (input.operation) {
    case "listApps":
      return desktop.listApps(context())
    case "getAppState":
      return desktop.getAppState(
        input.sessionId,
        input.locator,
        input.options,
        context(requireNonEmpty(input.turnKey, "turnKey"))
      )
    case "queryElements":
      return desktop.queryElements(input, input.locator, input.limit, context())
    case "expandElement":
      return desktop.expandElement(input.handle, input.continuationToken, input.limit, context())
    case "performAction":
      return desktop.performAction(
        input.request,
        context(requireNonEmpty(input.turnKey, "turnKey"))
      )
    case "zoom":
      return desktop.zoom(input, input.region, context())
  }
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must be a non-empty authenticated turn identifier`)
  }
  return value
}

export { __testing__ } from "./computer-use-proxy"
