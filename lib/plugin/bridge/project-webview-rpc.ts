/** Mirrors existing ctx.project document operations over the sandboxed webview transport. */
import { createProjectAPI } from "@/lib/plugin/api/project-api"
import { onWebviewMessage, postMessageToWebview } from "@/lib/plugin/registries/webview-registry"
import type { PluginProjectAPI } from "@/types/plugin/plugin"
import { useSettingsStore } from "@/stores/settings/settings-store"

export const PROJECT_WEBVIEW_CHANNEL = "cognia.project"
export const PROJECT_WEBVIEW_METHODS = [
  "listKnowledgeDocuments",
  "readKnowledgeOutline",
  "readKnowledgeRange",
  "locateKnowledgeDocument",
  "addKnowledgeFile",
  "updateKnowledgeFile",
  "removeKnowledgeFile",
] as const satisfies ReadonlyArray<keyof PluginProjectAPI>
export type ProjectWebviewMethod = (typeof PROJECT_WEBVIEW_METHODS)[number]
export type { PluginProjectWebviewAPI } from "@/types/plugin/plugin"
interface Attachment {
  refs: number
  dispose: () => void
}
const attachments = new Map<string, Attachment>()

export function attachProjectWebviewRpc(
  pluginId: string,
  webviewId: string,
  options: { hasPermission: (permission: string) => boolean }
): () => void {
  const fullId = `${pluginId}:${webviewId}`
  const existing = attachments.get(fullId)
  if (existing) existing.refs++
  else {
    const api = createProjectAPI(pluginId, {
      getReadingSettings: () => useSettingsStore.getState().settings?.knowledgeReading,
    })
    let active = true
    const inFlight = new Set<number>()
    const detach = onWebviewMessage(fullId, (message) => {
      const data = message.data
      if (!data || typeof data !== "object") return
      const request = data as Record<string, unknown>
      if (
        request.channel !== PROJECT_WEBVIEW_CHANNEL ||
        request.kind !== "request" ||
        !Number.isSafeInteger(request.id) ||
        (request.id as number) < 0
      )
        return
      const respond = (outcome: { ok: true; result: unknown } | { ok: false; error: string }) => {
        if (active)
          postMessageToWebview(fullId, {
            channel: PROJECT_WEBVIEW_CHANNEL,
            kind: "response",
            id: request.id,
            ...outcome,
          })
      }
      const id = request.id as number
      if (inFlight.has(id) || inFlight.size >= 32) {
        respond({ ok: false, error: "request_budget_exhausted" })
        return
      }
      inFlight.add(id)
      void (async () => {
        if (
          typeof request.method !== "string" ||
          !PROJECT_WEBVIEW_METHODS.includes(request.method as ProjectWebviewMethod) ||
          !Array.isArray(request.params)
        )
          throw new Error("invalid_project_request")
        const method = request.method as ProjectWebviewMethod
        const permission = [
          "addKnowledgeFile",
          "updateKnowledgeFile",
          "removeKnowledgeFile",
        ].includes(method)
          ? "project:write"
          : "project:read"
        const params = request.params
        const scope = (params[0] as { scope?: { kind?: unknown } } | undefined)?.scope
        const authorized = () =>
          options.hasPermission(permission) &&
          (scope?.kind !== "agent" || options.hasPermission("knowledge:read"))
        if (!authorized()) throw new Error("permission_denied")
        const result = await (api[method] as (...args: unknown[]) => unknown)(...params)
        // A response waiting on disk must not outlive permission revocation.
        if (!authorized()) throw new Error("permission_denied")
        return result
      })()
        .then(
          (result) => respond({ ok: true, result }),
          (error: unknown) =>
            respond({
              ok: false,
              error: error instanceof Error ? error.message : "project_request_failed",
            })
        )
        .finally(() => inFlight.delete(id))
    })
    attachments.set(fullId, {
      refs: 1,
      dispose: () => {
        active = false
        detach()
      },
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = attachments.get(fullId)
    if (!entry || --entry.refs > 0) return
    attachments.delete(fullId)
    entry.dispose()
  }
}

/** Once per iframe, asynchronous results and bounded request lifetimes. */
export function acquireCogniaProjectApiSource(): string {
  return `(function () {
    var claimed = false;
    window.acquireCogniaProjectApi = function () {
      if (claimed) throw new Error("acquireCogniaProjectApi() can only be called once.");
      claimed = true;
      var nextId = 1, pending = new Map();
      window.addEventListener("message", function (event) {
        if (event.source !== window.parent) return;
        var envelope = event.data, data = envelope && envelope.data;
        if (!envelope || envelope.__cogniaWebview !== "host" || !data || data.channel !== "${PROJECT_WEBVIEW_CHANNEL}" || data.kind !== "response") return;
        var entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id); clearTimeout(entry.timer);
        if (data.ok) entry.resolve(data.result);
        else entry.reject(new Error(data.error || "project_request_failed"));
      });
      window.addEventListener("pagehide", function () {
        pending.forEach(function (entry) { clearTimeout(entry.timer); entry.reject(new Error("webview_closed")); });
        pending.clear();
      });
      function call(method, params) {
        return new Promise(function (resolve, reject) {
          if (pending.size >= 32) { reject(new Error("request_budget_exhausted")); return; }
          var id = nextId++, timer = setTimeout(function () {
            pending.delete(id); reject(new Error("project_request_timeout"));
          }, 10000);
          pending.set(id, { resolve: resolve, reject: reject, timer: timer });
          window.parent.postMessage({ __cogniaWebview: "post", data: { channel: "${PROJECT_WEBVIEW_CHANNEL}", kind: "request", id: id, method: method, params: params } }, "*");
        });
      }
      return {
        ${PROJECT_WEBVIEW_METHODS.map((method) => `${method}: function () { return call("${method}", Array.prototype.slice.call(arguments)); }`).join(",\n")}
      };
    };
  }());`
}
