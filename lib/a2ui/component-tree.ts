/**
 * Structural reference helpers for the A2UI component graph.
 *
 * Renderers use more than the common `children` field: Card footers, Dialog
 * actions, Tabs/Accordion entries, overlay triggers, and List templates all
 * point at component ids. Editor mutations must traverse and rewrite the same
 * graph or they can leave a surface that renders with missing components.
 */

import type { A2UIComponent } from "@/types/a2ui/schema"

export interface A2UIComponentChildReference {
  id: string
  kind: "collection" | "required"
}

export interface A2UIComponentCollectionSlot {
  /** Opaque, component-local slot id. Pass back to mutation helpers unchanged. */
  id: string
  childIds: string[]
}

export interface A2UIComponentPlacement {
  parentId: string
  slotId: string
  /** Final zero-based position in the target slot; omitted means append. */
  index?: number
}

type UnknownRecord = Record<string, unknown>

const DIRECT_COLLECTION_FIELDS = ["children", "footer", "actions"] as const
type DirectCollectionField = (typeof DIRECT_COLLECTION_FIELDS)[number]

/**
 * Built-in renderer capabilities. Optional collection properties must remain
 * editable while empty; relying on property presence would make it impossible
 * to insert the first child into a valid empty container.
 */
const BUILT_IN_DIRECT_COLLECTION_FIELDS: Readonly<
  Record<string, readonly DirectCollectionField[]>
> = {
  Animation: ["children"],
  ButtonGroup: ["children"],
  Card: ["children", "footer"],
  Carousel: ["children"],
  Collapsible: ["children"],
  Column: ["children"],
  Dialog: ["children", "actions"],
  Drawer: ["children"],
  FormGroup: ["children"],
  HoverCard: ["children"],
  InputGroup: ["children"],
  List: ["children"],
  MockupFrame: ["children"],
  Popover: ["children"],
  Row: ["children"],
  ScrollArea: ["children"],
  Sheet: ["children"],
  Tooltip: ["children"],
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function supportsDirectCollectionField(
  record: UnknownRecord,
  field: DirectCollectionField
): boolean {
  if (Array.isArray(record[field])) return true
  if (typeof record.component !== "string") return false
  return BUILT_IN_DIRECT_COLLECTION_FIELDS[record.component]?.includes(field) ?? false
}

/** List every ordered collection slot that can accept child components. */
export function getComponentCollectionSlots(
  component: A2UIComponent
): A2UIComponentCollectionSlot[] {
  const record = component as unknown as UnknownRecord
  const slots: A2UIComponentCollectionSlot[] = []

  for (const field of DIRECT_COLLECTION_FIELDS) {
    if (supportsDirectCollectionField(record, field)) {
      slots.push({ id: `/${field}`, childIds: stringIds(record[field]) })
    }
  }

  for (const field of ["tabs", "items"] as const) {
    if (!Array.isArray(record[field])) continue
    record[field].forEach((entry, index) => {
      if (isRecord(entry) && Array.isArray(entry.children)) {
        slots.push({ id: `/${field}/${index}/children`, childIds: stringIds(entry.children) })
      }
    })
  }

  if (Array.isArray(record.steps)) {
    record.steps.forEach((step, index) => {
      if (isRecord(step) && Array.isArray(step.content)) {
        slots.push({ id: `/steps/${index}/content`, childIds: stringIds(step.content) })
      }
    })
  }

  return slots
}

/** Immutably rewrite one opaque collection slot, or return null when it no longer exists. */
export function rewriteComponentCollectionSlot(
  component: A2UIComponent,
  slotId: string,
  rewrite: (childIds: string[]) => string[]
): A2UIComponent | null {
  const source = component as unknown as UnknownRecord

  for (const field of DIRECT_COLLECTION_FIELDS) {
    if (slotId !== `/${field}` || !supportsDirectCollectionField(source, field)) continue
    const currentIds = stringIds(source[field])
    const nextIds = rewrite([...currentIds]).filter((id): id is string => typeof id === "string")
    if (sameIds(currentIds, nextIds)) return component
    return { ...source, [field]: nextIds } as unknown as A2UIComponent
  }

  for (const field of ["tabs", "items"] as const) {
    if (!Array.isArray(source[field])) continue
    for (let index = 0; index < source[field].length; index += 1) {
      if (slotId !== `/${field}/${index}/children`) continue
      const entry = source[field][index]
      if (!isRecord(entry) || !Array.isArray(entry.children)) return null
      const currentIds = stringIds(entry.children)
      const nextIds = rewrite([...currentIds]).filter((id): id is string => typeof id === "string")
      if (sameIds(currentIds, nextIds)) return component
      const nextEntries = [...source[field]]
      nextEntries[index] = { ...entry, children: nextIds }
      return { ...source, [field]: nextEntries } as unknown as A2UIComponent
    }
  }

  if (Array.isArray(source.steps)) {
    for (let index = 0; index < source.steps.length; index += 1) {
      if (slotId !== `/steps/${index}/content`) continue
      const step = source.steps[index]
      if (!isRecord(step) || !Array.isArray(step.content)) return null
      const currentIds = stringIds(step.content)
      const nextIds = rewrite([...currentIds]).filter((id): id is string => typeof id === "string")
      if (sameIds(currentIds, nextIds)) return component
      const nextSteps = [...source.steps]
      nextSteps[index] = { ...step, content: nextIds }
      return { ...source, steps: nextSteps } as unknown as A2UIComponent
    }
  }

  return null
}

/** Return every component id rendered by `component`, preserving occurrence order. */
export function getComponentChildReferences(
  component: A2UIComponent
): A2UIComponentChildReference[] {
  const record = component as unknown as UnknownRecord
  const references: A2UIComponentChildReference[] = []

  for (const field of DIRECT_COLLECTION_FIELDS) {
    for (const id of stringIds(record[field])) {
      references.push({ id, kind: "collection" })
    }
  }

  for (const field of ["tabs", "items"] as const) {
    if (!Array.isArray(record[field])) continue
    for (const entry of record[field]) {
      if (!isRecord(entry)) continue
      for (const id of stringIds(entry.children)) {
        references.push({ id, kind: "collection" })
      }
    }
  }

  if (Array.isArray(record.steps)) {
    for (const step of record.steps) {
      if (!isRecord(step)) continue
      for (const id of stringIds(step.content)) {
        references.push({ id, kind: "collection" })
      }
    }
  }

  if (typeof record.trigger === "string") {
    references.push({ id: record.trigger, kind: "required" })
  }

  if (isRecord(record.template) && typeof record.template.itemId === "string") {
    references.push({ id: record.template.itemId, kind: "required" })
  }

  return references
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Immutably rewrite every structural component reference.
 *
 * Collection callbacks may return zero or more ids. Required callbacks use
 * their first returned id; returning an empty list removes the required field,
 * which callers should only do after cascading or validating the owner.
 */
export function rewriteComponentChildReferences(
  component: A2UIComponent,
  rewrite: (reference: A2UIComponentChildReference) => string[]
): A2UIComponent {
  const source = component as unknown as UnknownRecord
  let result = source

  const ensureCopy = () => {
    if (result === source) result = { ...source }
    return result
  }
  const rewriteCollection = (ids: string[]) =>
    ids.flatMap((id) => rewrite({ id, kind: "collection" })).filter((id) => typeof id === "string")

  for (const field of DIRECT_COLLECTION_FIELDS) {
    const ids = stringIds(source[field])
    if (!Array.isArray(source[field])) continue
    const nextIds = rewriteCollection(ids)
    if (!sameIds(ids, nextIds)) ensureCopy()[field] = nextIds
  }

  for (const field of ["tabs", "items"] as const) {
    const entries = source[field]
    if (!Array.isArray(entries)) continue
    let entriesChanged = false
    const nextEntries = entries.map((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.children)) return entry
      const ids = stringIds(entry.children)
      const nextIds = rewriteCollection(ids)
      if (sameIds(ids, nextIds)) return entry
      entriesChanged = true
      return { ...entry, children: nextIds }
    })
    if (entriesChanged) ensureCopy()[field] = nextEntries
  }

  if (Array.isArray(source.steps)) {
    let stepsChanged = false
    const nextSteps = source.steps.map((step) => {
      if (!isRecord(step) || !Array.isArray(step.content)) return step
      const ids = stringIds(step.content)
      const nextIds = rewriteCollection(ids)
      if (sameIds(ids, nextIds)) return step
      stepsChanged = true
      return { ...step, content: nextIds }
    })
    if (stepsChanged) ensureCopy().steps = nextSteps
  }

  if (typeof source.trigger === "string") {
    const nextId = rewrite({ id: source.trigger, kind: "required" })[0]
    if (nextId !== source.trigger) {
      if (nextId === undefined) delete ensureCopy().trigger
      else ensureCopy().trigger = nextId
    }
  }

  if (isRecord(source.template) && typeof source.template.itemId === "string") {
    const nextId = rewrite({ id: source.template.itemId, kind: "required" })[0]
    if (nextId !== source.template.itemId) {
      const nextTemplate = { ...source.template }
      if (nextId === undefined) delete nextTemplate.itemId
      else nextTemplate.itemId = nextId
      ensureCopy().template = nextTemplate
    }
  }

  return result as unknown as A2UIComponent
}

/** Collect a component and all structural descendants without looping on malformed cycles. */
export function collectComponentSubtreeIds(
  components: Record<string, A2UIComponent>,
  rootId: string
): Set<string> {
  const collected = new Set<string>()
  const pending = [rootId]

  while (pending.length > 0) {
    const componentId = pending.pop()!
    if (collected.has(componentId) || !components[componentId]) continue
    collected.add(componentId)
    const references = getComponentChildReferences(components[componentId])
    for (let index = references.length - 1; index >= 0; index -= 1) {
      pending.push(references[index].id)
    }
  }

  return collected
}

/** Detect a structural reference cycle reachable from one component id. */
export function hasComponentReferenceCycle(
  components: Record<string, A2UIComponent>,
  rootId: string
): boolean {
  const visited = new Set<string>()
  const active = new Set<string>()
  const pending: Array<{ id: string; exiting: boolean }> = [{ id: rootId, exiting: false }]

  while (pending.length > 0) {
    const frame = pending.pop()!
    if (!components[frame.id]) continue
    if (frame.exiting) {
      active.delete(frame.id)
      visited.add(frame.id)
      continue
    }
    if (active.has(frame.id)) return true
    if (visited.has(frame.id)) continue

    active.add(frame.id)
    pending.push({ id: frame.id, exiting: true })
    const references = getComponentChildReferences(components[frame.id])
    for (let index = references.length - 1; index >= 0; index -= 1) {
      pending.push({ id: references[index].id, exiting: false })
    }
  }

  return false
}

/** A duplicate needs a collection slot outside its own subtree to attach beside the source. */
export function canDuplicateComponentSubtree(
  components: Record<string, A2UIComponent>,
  surfaceRootId: string,
  componentId: string
): boolean {
  if (componentId === surfaceRootId || !components[componentId]) return false
  const subtreeIds = collectComponentSubtreeIds(components, componentId)
  if (subtreeIds.has(surfaceRootId)) return false

  return Object.entries(components).some(
    ([ownerId, owner]) =>
      !subtreeIds.has(ownerId) &&
      getComponentChildReferences(owner).some(
        (reference) => reference.kind === "collection" && reference.id === componentId
      )
  )
}
