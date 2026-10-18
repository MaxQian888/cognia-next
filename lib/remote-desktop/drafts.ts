/**
 * Pure helpers between the wizard's form and the Host's draft shape. A target
 * may hold up to eight bindings; the console edits one at a time and passes
 * the others back unchanged, so an edit never drops a binding it did not show.
 *
 * A binding reaches its machine one of three ways (ADR-0234 Phase 5): the
 * Host bridges a host and port, the client opens a web console link (whose
 * host the Host pins like any other endpoint), or the client hands an ID to
 * an app. The form carries the fields of all three and the draft only those
 * of the binding's access.
 */

import type {
  RemoteDesktopAccess,
  RemoteDesktopBinding,
  RemoteDesktopBindingDraft,
  RemoteDesktopConsoleProfile,
  RemoteDesktopTarget,
  RemoteDesktopTargetDraft,
} from "./types"

export interface RemoteDesktopForm {
  name: string
  providerId: string
  access: RemoteDesktopAccess
  adapter: RemoteDesktopBinding["adapter"]
  /** `bridge`. */
  host: string
  port: number
  /** `web-console`: the page the user pasted. */
  consoleUrl: string
  consoleProfile: RemoteDesktopConsoleProfile
  /** `external-app` (RustDesk). */
  peerId: string
  server: string
  key: string
  viewOnly: boolean
  enabled: boolean
  /** The user ticked the endpoint confirmation for the checked address. */
  confirm: boolean
}

/** `undefined` keeps the stored value, `null` clears it, a string sets it. */
export type CredentialChange = string | null | undefined

/** The form's fields that are not the binding's own. */
export const EMPTY_FORM_EXTRAS = {
  consoleUrl: "",
  consoleProfile: "generic",
  peerId: "",
  server: "",
  key: "",
} as const satisfies Partial<RemoteDesktopForm>

export function bindingDraftOf(binding: RemoteDesktopBinding): RemoteDesktopBindingDraft {
  const access = binding.access ?? "bridge"
  const common = {
    id: binding.id,
    providerId: binding.providerId,
    access,
    adapter: binding.adapter,
    priority: binding.priority,
    enabled: binding.enabled,
    viewOnly: binding.viewOnly,
    config: binding.config,
    confirm: false,
  }
  if (access === "web-console") {
    const profile = binding.console?.profile ?? "generic"
    return { ...common, console: { url: binding.console?.url ?? "", profile } }
  }
  if (access === "external-app") {
    const { server, key } = binding.launch ?? {}
    return {
      ...common,
      launch: {
        launcher: "rustdesk",
        peerId: binding.launch?.peerId ?? "",
        ...(server ? { server } : {}),
        ...(key ? { key } : {}),
      },
    }
  }
  return { ...common, host: binding.endpoint?.host ?? "", port: binding.endpoint?.port ?? 0 }
}

export function formOf(
  target: RemoteDesktopTarget,
  binding: RemoteDesktopBinding
): RemoteDesktopForm {
  return {
    ...EMPTY_FORM_EXTRAS,
    name: target.name,
    providerId: binding.providerId,
    access: binding.access ?? "bridge",
    adapter: binding.adapter,
    host: binding.access === "bridge" || !binding.access ? (binding.endpoint?.host ?? "") : "",
    port: binding.endpoint?.port ?? 0,
    consoleUrl: binding.console?.url ?? "",
    consoleProfile: binding.console?.profile ?? "generic",
    peerId: binding.launch?.peerId ?? "",
    server: binding.launch?.server ?? "",
    key: binding.launch?.key ?? "",
    viewOnly: binding.viewOnly,
    enabled: binding.enabled,
    confirm: false,
  }
}

/** A console link's host and port, as the Host pins them; null when unparsable. */
export function consoleEndpointOf(url: string): { host: string; port: number } | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) return null
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "")
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80
  return { host, port }
}

/** The endpoint the form asks the Host to pin; null for an external app. */
export function endpointOf(
  form: Pick<RemoteDesktopForm, "access" | "host" | "port" | "consoleUrl">
): { host: string; port: number } | null {
  if (form.access === "external-app") return null
  if (form.access === "web-console") return consoleEndpointOf(form.consoleUrl)
  return { host: form.host.trim(), port: form.port }
}

/**
 * Why a console link cannot be saved, as the Host's refusal code, or null.
 * The Host checks again (`console::parse`); this only spares a round trip.
 */
export function consoleLinkProblem(
  url: string,
  profile: RemoteDesktopConsoleProfile
): string | null {
  if (!consoleEndpointOf(url)) return "remote_desktop_console_url_invalid"
  const parsed = new URL(url.trim())
  if (parsed.username || parsed.password) return "remote_desktop_console_url_has_credentials"
  if (profile === "guacamole") {
    const route = parsed.hash.replace(/^#/, "")
    if (!/^\/client\/[^?]+/.test(route)) return "remote_desktop_console_url_invalid"
  }
  if (profile === "meshcentral") {
    const selects = ["gotonode", "gotodevicename"].some(
      (key) => (parsed.searchParams.get(key) ?? "").trim() !== ""
    )
    if (!selects) return "remote_desktop_console_url_invalid"
  }
  return null
}

/** Whether the form's address differs from what the binding has pinned. */
export function endpointChanged(
  binding: RemoteDesktopBinding | undefined,
  endpoint: { host: string; port: number } | null
): boolean {
  if (!endpoint) return false
  if (!binding?.endpoint) return true
  return binding.endpoint.host !== endpoint.host.trim() || binding.endpoint.port !== endpoint.port
}

function editedDraftOf(form: RemoteDesktopForm, bindingId?: string): RemoteDesktopBindingDraft {
  const common = {
    ...(bindingId ? { id: bindingId } : {}),
    providerId: form.providerId,
    access: form.access,
    enabled: form.enabled,
    confirm: form.confirm,
  }
  if (form.access === "web-console") {
    return {
      ...common,
      adapter: "none",
      viewOnly: false,
      console: { url: form.consoleUrl.trim(), profile: form.consoleProfile },
    }
  }
  if (form.access === "external-app") {
    const server = form.server.trim()
    const key = form.key.trim()
    return {
      ...common,
      adapter: "none",
      viewOnly: false,
      confirm: false,
      launch: {
        launcher: "rustdesk",
        peerId: form.peerId.replace(/\s+/g, ""),
        ...(server ? { server } : {}),
        ...(key ? { key } : {}),
      },
    }
  }
  return {
    ...common,
    adapter: form.adapter,
    host: form.host.trim(),
    port: form.port,
    viewOnly: form.adapter === "vnc" && form.viewOnly,
  }
}

/**
 * The draft to save. `existing` and `bindingId` name the binding being edited;
 * without them a new target with one binding is created.
 */
export function targetDraftOf(
  form: RemoteDesktopForm,
  existing?: RemoteDesktopTarget,
  bindingId?: string
): RemoteDesktopTargetDraft {
  const edited = editedDraftOf(form, bindingId)
  const previous = existing?.bindings.find((binding) => binding.id === bindingId)
  if (previous) {
    edited.priority = previous.priority
    edited.config = previous.config
  }
  const others = (existing?.bindings ?? [])
    .filter((binding) => binding.id !== bindingId)
    .map(bindingDraftOf)
  return {
    ...(existing ? { id: existing.id } : {}),
    name: form.name.trim(),
    bindings: previous
      ? (existing?.bindings ?? []).map((binding) =>
          binding.id === bindingId ? edited : others.find((other) => other.id === binding.id)!
        )
      : [...others, edited],
  }
}

/** The binding a saved draft produced: the edited id, or the one that is new. */
export function savedBindingOf(
  saved: RemoteDesktopTarget,
  existing: RemoteDesktopTarget | undefined,
  bindingId: string | undefined
): RemoteDesktopBinding | undefined {
  if (bindingId) return saved.bindings.find((binding) => binding.id === bindingId)
  const known = new Set(existing?.bindings.map((binding) => binding.id) ?? [])
  return saved.bindings.find((binding) => !known.has(binding.id))
}

/** The binding a target opens with: the first enabled one by priority. */
export function primaryBindingOf(target: RemoteDesktopTarget): RemoteDesktopBinding | undefined {
  return [...target.bindings]
    .filter((binding) => binding.enabled)
    .sort((a, b) => a.priority - b.priority)[0]
}
