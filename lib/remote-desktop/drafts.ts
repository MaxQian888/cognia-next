/**
 * Pure helpers between the wizard's form and the Host's draft shape. A target
 * may hold up to eight bindings; the console edits one at a time and passes
 * the others back unchanged, so an edit never drops a binding it did not show.
 */

import type {
  RemoteDesktopBinding,
  RemoteDesktopBindingDraft,
  RemoteDesktopTarget,
  RemoteDesktopTargetDraft,
} from "./types"

export interface RemoteDesktopForm {
  name: string
  providerId: string
  adapter: RemoteDesktopBinding["adapter"]
  host: string
  port: number
  viewOnly: boolean
  enabled: boolean
  /** The user ticked the endpoint confirmation for the checked address. */
  confirm: boolean
}

/** `undefined` keeps the stored value, `null` clears it, a string sets it. */
export type CredentialChange = string | null | undefined

export function bindingDraftOf(binding: RemoteDesktopBinding): RemoteDesktopBindingDraft {
  return {
    id: binding.id,
    providerId: binding.providerId,
    adapter: binding.adapter,
    priority: binding.priority,
    enabled: binding.enabled,
    host: binding.endpoint.host,
    port: binding.endpoint.port,
    viewOnly: binding.viewOnly,
    config: binding.config,
    confirm: false,
  }
}

export function formOf(
  target: RemoteDesktopTarget,
  binding: RemoteDesktopBinding
): RemoteDesktopForm {
  return {
    name: target.name,
    providerId: binding.providerId,
    adapter: binding.adapter,
    host: binding.endpoint.host,
    port: binding.endpoint.port,
    viewOnly: binding.viewOnly,
    enabled: binding.enabled,
    confirm: false,
  }
}

/** Whether the form's address differs from what the binding has pinned. */
export function endpointChanged(
  binding: RemoteDesktopBinding | undefined,
  form: Pick<RemoteDesktopForm, "host" | "port">
): boolean {
  if (!binding) return true
  return binding.endpoint.host !== form.host.trim() || binding.endpoint.port !== form.port
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
  const edited: RemoteDesktopBindingDraft = {
    ...(bindingId ? { id: bindingId } : {}),
    providerId: form.providerId,
    adapter: form.adapter,
    enabled: form.enabled,
    host: form.host.trim(),
    port: form.port,
    viewOnly: form.adapter === "vnc" && form.viewOnly,
    confirm: form.confirm,
  }
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
