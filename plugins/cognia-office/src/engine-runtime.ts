import { definePluginTool, type PluginContext } from "@cognia/plugin-sdk"
import type { PreviewTranslator } from "./preview"

type EngineAPI = PluginContext["nodeRuntime"]
export type EngineStatus = Awaited<ReturnType<EngineAPI["status"]>>
export type EngineAction = "status" | "prepare" | "probe" | "cancel" | "remove"
type EngineContext = Pick<PluginContext, "nodeRuntime" | "permissions" | "i18n">

export const OFFICE_ENGINE_TOOL = "office_engine_runtime"
const ACTIONS: readonly EngineAction[] = ["status", "prepare", "probe", "cancel", "remove"]

/** Plugin-owned controller: construction and activation never install or import the engine. */
export function createOfficeEngineController(ctx: EngineContext) {
  let status: EngineStatus | undefined
  let pending: EngineAction | undefined
  let error: string | undefined
  let sequence = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener()
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!disposed && !error && status?.state === "preparing")
      timer = setTimeout(() => {
        void run("status").catch(() => {
          // A transport failure stays visible and can be retried explicitly.
        })
      }, 1000)
  }
  async function run(action: EngineAction): Promise<EngineStatus> {
    if (disposed) throw new Error(ctx.i18n.t("engine.disposed"))
    if (pending && action !== "cancel") throw new Error(ctx.i18n.t("engine.busy"))
    if (!ACTIONS.includes(action)) throw new Error(ctx.i18n.t("engine.invalidAction"))
    const request = ++sequence
    pending = action
    error = undefined
    clearTimeout(timer)
    notify()
    try {
      if (action !== "status") {
        const permissions =
          action === "prepare"
            ? (["shell:execute", "network:fetch"] as const)
            : (["shell:execute"] as const)
        for (const permission of permissions) {
          if (disposed || request !== sequence) throw new Error(ctx.i18n.t("engine.disposed"))
          if (
            !ctx.permissions.hasPermission(permission) &&
            !(await ctx.permissions.requestPermission(permission, ctx.i18n.t("engine.permission")))
          )
            throw new Error(ctx.i18n.t("engine.permissionDenied"))
        }
      }
      if (disposed || request !== sequence) throw new Error(ctx.i18n.t("engine.disposed"))
      const result = await ctx.nodeRuntime[action]()
      if (!disposed && request === sequence) {
        status = result
        error = result.error?.message
      } else if (action === "prepare" && result.state === "preparing") {
        await ctx.nodeRuntime.cancel()
      }
      return result
    } catch (cause) {
      if (request === sequence) error = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      if (request === sequence) {
        pending = undefined
        notify()
        schedule()
      }
    }
  }
  return {
    get status() {
      return status
    },
    get pending() {
      return pending
    },
    get error() {
      return error
    },
    run,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async dispose() {
      disposed = true
      clearTimeout(timer)
      listeners.clear()
      if (status?.state === "preparing") {
        try {
          await ctx.nodeRuntime.cancel()
        } catch {
          /* Host lifecycle also cancels on unload. */
        }
      }
    },
  }
}

export type OfficeEngineController = ReturnType<typeof createOfficeEngineController>

export function createOfficeEngineTool(controller: OfficeEngineController) {
  return definePluginTool({
    name: OFFICE_ENGINE_TOOL,
    definition: {
      name: OFFICE_ENGINE_TOOL,
      description:
        "Manage this plugin's optional Office engine dependencies. status reads installation state; " +
        "prepare downloads pinned official packages only when the user requests installation; " +
        "probe dynamically loads the installed module in a short-lived host process; cancel stops " +
        "installation; remove deletes the plugin's runtime cache. Poll status after prepare. " +
        "This tool does not convert documents or establish rendering/sandbox availability.",
      timeoutMs: 45_000,
      parametersSchema: {
        type: "object",
        properties: { action: { type: "string", enum: [...ACTIONS] } },
        required: ["action"],
        additionalProperties: false,
      },
    },
    execute: async (args) => controller.run((args as { action: EngineAction }).action),
  })
}

/** Reuses the workbook toolbar styles and the plugin's existing localization bundle. */
export function renderOfficeEngineBar(controller: OfficeEngineController, t: PreviewTranslator) {
  const bar = document.createElement("div")
  bar.className = "copv-toolbar"
  bar.setAttribute("role", "group")
  bar.setAttribute("aria-label", t("engine.title"))
  const { status, pending, error } = controller
  const busy = !!pending || status?.state === "preparing"
  const add = (action: EngineAction, label: string, locked = busy) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "copv-btn"
    button.textContent = t(label)
    button.dataset.focusKey = `engine:${action}`
    button.setAttribute("aria-disabled", String(locked))
    button.addEventListener("click", () => {
      if (!locked)
        void controller.run(action).catch(() => {
          /* Controller renders the error. */
        })
    })
    bar.append(button)
  }
  add("status", "engine.check", !!pending)
  if (status?.state === "preparing") add("cancel", "engine.cancel", pending === "cancel")
  else if (status?.prepared) {
    add("probe", "engine.probe")
    add("remove", "engine.remove")
  } else add("prepare", "engine.install")
  const message = document.createElement("span")
  message.className = "copv-export-status"
  message.setAttribute("role", error ? "alert" : "status")
  message.textContent = error
    ? t("engine.error", { error })
    : pending
      ? t("engine.working")
      : status?.probe
        ? t("engine.loaded")
        : t(`engine.state.${status?.state ?? "unchecked"}`)
  bar.append(message)
  return bar
}
