"use client"

/**
 * An owner resource's current text (ADR-0236 §5.1), read through the adapter
 * that owns it. The caller reloads after a write; the adapter's document
 * carries the precondition the next save is checked against.
 */

import { useCallback, useEffect, useState } from "react"
import { ownerAdapterFor } from "@/lib/prompts/adapters"
import type { OwnerPromptDocument, PromptResourceContext } from "@/lib/prompts/resources"

export type OwnerPromptDocumentState =
  | { status: "loading" }
  | { status: "ready"; document: OwnerPromptDocument }
  | { status: "missing" }
  | { status: "error"; error: string }

export function useOwnerPromptDocument(
  key: string,
  ctx: PromptResourceContext
): { state: OwnerPromptDocumentState; reload: () => void } {
  const [epoch, setEpoch] = useState(0)
  const [state, setState] = useState<OwnerPromptDocumentState>({ status: "loading" })
  const [loadedFor, setLoadedFor] = useState(key)
  const reload = useCallback(() => setEpoch((value) => value + 1), [])

  // A different resource starts from "loading", never from the previous text.
  if (loadedFor !== key) {
    setLoadedFor(key)
    setState({ status: "loading" })
  }

  const adapter = ownerAdapterFor(key)

  useEffect(() => {
    if (!adapter) return
    let cancelled = false
    adapter
      .read(key, ctx)
      .then((document) => {
        if (!cancelled) setState(document ? { status: "ready", document } : { status: "missing" })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [adapter, key, ctx, epoch])

  return { state: adapter ? state : { status: "missing" }, reload }
}
