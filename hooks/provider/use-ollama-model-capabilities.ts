"use client"

/**
 * useOllamaModelCapabilities — what each installed model can actually do.
 *
 * Asks the server (`/api/show` → `capabilities`) instead of guessing from the
 * model name. The name heuristic it replaces is genuinely bad: it matches
 * `llava`/`vision` substrings, so `qwen2.5-vl`, `moondream` and `minicpm-v` all
 * read as text-only, and it knows nothing about tools or thinking at all.
 *
 * Ollama-only by design. `/api/show` is Ollama's endpoint; the other nine local
 * providers expose no equivalent, so for them this reports nothing rather than
 * inventing something.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { LocalProviderName } from "@cognia/provider-types/local-provider"
import type { OllamaModelCapabilities } from "@cognia/provider-types/ollama"
import { probeOllamaModelCapabilities } from "@cognia/provider-core/providers/ollama"

export interface UseOllamaModelCapabilitiesArgs {
  providerId: LocalProviderName
  baseUrl?: string
  /** Installed model ids, as returned by the model list. */
  modelIds: string[]
}

export interface UseOllamaModelCapabilitiesResult {
  /** Keyed by model id. Absent while a probe is in flight or unsupported. */
  capabilities: Map<string, OllamaModelCapabilities>
  isProbing: boolean
}

export function useOllamaModelCapabilities(
  args: UseOllamaModelCapabilitiesArgs
): UseOllamaModelCapabilitiesResult {
  const { providerId, baseUrl, modelIds } = args

  const [capabilities, setCapabilities] = useState<Map<string, OllamaModelCapabilities>>(
    () => new Map()
  )
  const [isProbing, setIsProbing] = useState(false)

  /**
   * Models already probed (or in flight), keyed `baseUrl|model`. One round-trip
   * per model is the cost of a real answer, so it must be paid once — not on
   * every render, and not again when the list re-renders unchanged. Keyed by
   * baseUrl so pointing at a different server re-probes rather than serving
   * another machine's answers.
   */
  const probed = useRef(new Set<string>())

  const probeAll = useCallback(async () => {
    if (providerId !== "ollama" || !baseUrl || modelIds.length === 0) return

    const pending = modelIds.filter((id) => !probed.current.has(`${baseUrl}|${id}`))
    if (pending.length === 0) return

    pending.forEach((id) => probed.current.add(`${baseUrl}|${id}`))
    setIsProbing(true)
    try {
      const results = await Promise.all(
        pending.map(async (id) => [id, await probeOllamaModelCapabilities(baseUrl, id)] as const)
      )
      setCapabilities((prev) => {
        const next = new Map(prev)
        for (const [id, caps] of results) next.set(id, caps)
        return next
      })
    } finally {
      setIsProbing(false)
    }
  }, [providerId, baseUrl, modelIds])

  useEffect(() => {
    void probeAll()
  }, [probeAll])

  return { capabilities, isProbing }
}
