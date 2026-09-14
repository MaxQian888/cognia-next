"use client"

/**
 * Hand a panel catalogue's changing facts to its renderers without making those
 * facts part of the renderers' identity.
 *
 * The context workbench mounts a panel as `<panel.renderer />`, so a renderer is
 * a component TYPE: a new function is a new component, and React unmounts the
 * old subtree and mounts a fresh one in its place. The dock catalogues used to
 * build each renderer as a closure over the facts it needed, inside a `useMemo`
 * keyed on those facts — so a change to any of them remounted every stateful
 * panel. A live-query `session` object is a new object on every read, the
 * message list is a new array on every streamed token, an artifact is a new
 * object on every save: the sidechat flashed back to its empty state several
 * times a second (and its own mount wrote the row that re-ran the query, so it
 * never settled), the embedded browser dropped its page, Monaco its buffers.
 *
 * A catalogue now creates ONE of these stores, closes its renderers over the
 * store, and each panel reads what it renders through `usePanelInput` — which
 * re-renders it, and does not remount it, when that slice changes.
 */

import { useLayoutEffect, useState } from "react"
import { useStore } from "zustand"
import { createStore, type StoreApi } from "zustand/vanilla"

export type PanelInputs<T extends object> = StoreApi<T>

function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

/**
 * The latest `input`, in a store whose identity never changes for the life of
 * the calling component.
 *
 * Published after each commit rather than during render: writing the store while
 * this component renders would update the subscribed panels mid-render, which
 * React reports as an update to one component while rendering another. The
 * store starts with the first render's input, so a panel's first render is
 * never behind. A publish that changes nothing notifies no one.
 */
export function usePanelInputs<T extends object>(input: T): PanelInputs<T> {
  const [store] = useState(() => createStore<T>(() => input))
  useLayoutEffect(() => {
    if (!shallowEqual(store.getState(), input)) store.setState(input, true)
  })
  return store
}

/**
 * Read one slice of a catalogue's inputs.
 *
 * Re-renders only when the selected value changes (`Object.is`), so select a
 * field, not a freshly built object.
 */
export function usePanelInput<T extends object, S>(
  store: PanelInputs<T>,
  select: (input: T) => S
): S {
  return useStore(store, select)
}
