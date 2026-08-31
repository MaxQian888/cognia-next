import type {
  PluginSelectionContentType,
  PluginSelectionOrigin,
  PluginSelectionActionSpec,
} from "@/types/plugin"
import type { SelectionActionLayout } from "./preferences"

export interface SelectionHostActionDescriptor extends PluginSelectionActionSpec {
  /** Built-ins use their stable id; plugin actions use the registry full id. */
  id: string
  title: string
  source: "builtin" | "cognia" | "plugin"
  pluginId?: string
  icon?: string
  attribution?: string
  accelerator?: string
  /** A declaration, never authority; user allowlisting is checked separately. */
  directReplace?: boolean
  children?: Array<{ id: string; title: string }>
  contentTypes?: PluginSelectionContentType[]
  origins?: PluginSelectionOrigin[]
}

export interface SelectionActionSlots {
  primaryIds: string[]
  overflowIds: string[]
}

const MAX_PRIMARY_ACTIONS = 6

export function resolveSelectionActionSlots(input: {
  builtInIds: readonly string[]
  pluginActions: readonly SelectionHostActionDescriptor[]
  layout: SelectionActionLayout
}): SelectionActionSlots {
  const hidden = new Set(input.layout.hidden)
  const eligible = [...input.builtInIds, ...input.pluginActions.map((action) => action.id)].filter(
    (id, index, all) => (id === "copy" || !hidden.has(id)) && all.indexOf(id) === index
  )
  const defaultIndex = new Map(eligible.map((id, index) => [id, index]))
  const orderedIndex = new Map(input.layout.ordered.map((id, index) => [id, index]))

  eligible.sort((a, b) => {
    const aOrdered = orderedIndex.get(a)
    const bOrdered = orderedIndex.get(b)
    if (aOrdered !== undefined || bOrdered !== undefined) {
      if (aOrdered === undefined) return 1
      if (bOrdered === undefined) return -1
      return aOrdered - bOrdered
    }
    return (defaultIndex.get(a) ?? 0) - (defaultIndex.get(b) ?? 0)
  })

  const copyIndex = eligible.indexOf("copy")
  if (copyIndex > 0) {
    eligible.splice(copyIndex, 1)
    eligible.unshift("copy")
  }

  // A pin guarantees a primary slot even if the user did not explicitly
  // order it. Copy remains the immovable safety action at the head.
  let pinInsertion = eligible[0] === "copy" ? 1 : 0
  for (const pinned of input.layout.pinned) {
    const index = eligible.indexOf(pinned)
    if (index < 0 || index < MAX_PRIMARY_ACTIONS) continue
    eligible.splice(index, 1)
    eligible.splice(pinInsertion, 0, pinned)
    pinInsertion += 1
  }

  return {
    primaryIds: eligible.slice(0, MAX_PRIMARY_ACTIONS),
    overflowIds: eligible.slice(MAX_PRIMARY_ACTIONS),
  }
}

export function pluginActionIsEligible(
  action: SelectionHostActionDescriptor,
  input: {
    origin: PluginSelectionOrigin
    contentTypes: readonly PluginSelectionContentType[]
    chars: number
  }
): boolean {
  if (action.origins?.length && !action.origins.includes(input.origin)) return false
  if (
    action.contentTypes?.length &&
    !action.contentTypes.some((type) => input.contentTypes.includes(type))
  ) {
    return false
  }
  return action.maxChars === undefined || input.chars <= action.maxChars
}
