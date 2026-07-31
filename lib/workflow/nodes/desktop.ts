/**
 * Revision-bound desktop workflow nodes.
 *
 * Workflows consume the same canonical app-session contract as the model and
 * Inspector. They may run while the Mac is unlocked, but expose no Locked Use
 * installation or unlock operation.
 */

import { desktop, type CallContext } from "@/lib/automation/client"
import type {
  ActionRequest,
  AppLocator,
  ElementHandle,
  EventKind,
  GetAppStateOptions,
  Locator,
} from "@/lib/automation/types"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "./registry"

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function objectParam<T>(params: Record<string, unknown>, key: string): T {
  const value = params[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`action.desktop.${key} requires an object '${key}'`)
  }
  return value as T
}

function callContext(ctx: StepExecutionContext): CallContext {
  return {
    surface: "workflow",
    sessionKey: ctx.workflowId,
    // A workflow run is the authenticated automation turn. Single-use tokens
    // still require a new state read after each mutation.
    turnKey: ctx.runId,
  }
}

function defaultSessionId(ctx: StepExecutionContext): string {
  return `workflow:${ctx.workflowId}:${ctx.runId}`
}

registerNodeExecutor({
  kind: "action.desktop.listApps",
  typeVersion: 1,
  execute: async (ctx) => ({
    output: { apps: await desktop.listApps(callContext(ctx)) },
  }),
})

registerNodeExecutor({
  kind: "action.desktop.getAppState",
  typeVersion: 1,
  execute: async (ctx) => {
    const locator = objectParam<AppLocator>(ctx.params, "locator")
    const options = (ctx.params.options as GetAppStateOptions | undefined) ?? {}
    const sessionId = stringParam(ctx.params, "sessionId") ?? defaultSessionId(ctx)
    const state = await desktop.getAppState(sessionId, locator, options, callContext(ctx))
    return { output: state }
  },
})

registerNodeExecutor({
  kind: "action.desktop.queryElements",
  typeVersion: 1,
  execute: async (ctx) => {
    const sessionId = stringParam(ctx.params, "sessionId")
    const lineageId = stringParam(ctx.params, "lineageId")
    const revision = numberParam(ctx.params, "revision")
    if (!sessionId || !lineageId || revision === undefined) {
      throw new Error("action.desktop.queryElements requires sessionId, lineageId, and revision")
    }
    const locator = (ctx.params.locator as Locator | undefined) ?? {}
    const limit = numberParam(ctx.params, "limit")
    const nodes = await desktop.queryElements(
      { sessionId, lineageId, revision },
      locator,
      limit,
      callContext(ctx)
    )
    return { output: { nodes } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.expandElement",
  typeVersion: 1,
  execute: async (ctx) => {
    const handle = objectParam<ElementHandle>(ctx.params, "handle")
    const continuationToken =
      typeof ctx.params.continuationToken === "string" ? ctx.params.continuationToken : null
    const page = await desktop.expandElement(
      handle,
      continuationToken,
      numberParam(ctx.params, "limit"),
      callContext(ctx)
    )
    return { output: page }
  },
})

registerNodeExecutor({
  kind: "action.desktop.performAction",
  typeVersion: 1,
  execute: async (ctx) => {
    const request = objectParam<ActionRequest>(ctx.params, "request")
    const result = await desktop.performAction(request, callContext(ctx))
    return { output: result }
  },
})

registerNodeExecutor({
  kind: "trigger.desktop.event",
  typeVersion: 1,
  execute: async (ctx) => {
    const kinds = (Array.isArray(ctx.params.kinds) ? ctx.params.kinds : []) as EventKind[]
    return {
      output: {
        kinds,
        firedAt: ctx.trigger.originAt,
        payload: ctx.trigger.payload,
      },
    }
  },
})
