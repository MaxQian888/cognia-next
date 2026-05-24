"use client"

import { useState } from "react"
import type { Character } from "@/lib/claude/types"

/**
 * Stable `Map<string, Character>` over the output of `useCharacters()`.
 *
 * Problem: `useCharacters()` is backed by `dexie-react-hooks/useLiveQuery`,
 * which returns a **new array reference** on every Dexie write—even when the
 * underlying data hasn't changed.  A naive `useMemo(() => new Map(...),
 * [charactersList])` therefore rebuilds the Map on every unrelated Dexie
 * mutation, busting downstream `React.memo` equality checks (e.g.
 * `MessageRenderer`).
 *
 * This hook caches the Map and only rebuilds when the *content* of the list
 * actually changes, determined by an `id`-join signature.  It uses the
 * React-blessed "adjust state during render" pattern (rather than `useMemo`
 * keyed on a signature, which would either rebuild on every render or capture
 * the unstable list reference in a dependency-incomplete memo).
 */
function buildMap(list: Character[]): Map<string, Character> {
  const map = new Map<string, Character>()
  for (const c of list) map.set(c.id, c)
  return map
}

export function useStableCharacterById(
  charactersList: Character[] | undefined
): Map<string, Character> {
  const list = charactersList ?? []
  const signature = list.map((c) => c.id).join(":")

  const [cache, setCache] = useState(() => ({
    signature,
    map: buildMap(list),
  }))

  if (cache.signature !== signature) {
    const next = { signature, map: buildMap(list) }
    setCache(next)
    return next.map
  }

  return cache.map
}
