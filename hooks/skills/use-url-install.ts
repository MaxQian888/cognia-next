"use client"

// UI hook behind the "Install from URL" dialog: parse → resolve → install.
// Keeps the dialog presentational; all skills.sh specifics live in the lib.

import { useCallback, useState } from "react"
import { installMarketplaceItem } from "@/lib/skills/marketplace-install"
import { parseSkillsShInput, resolveSkillsShRef } from "@/lib/skills/skillssh-github"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

export interface UseUrlInstall {
  /** Parse + resolve + install. Resolves to the installed item. */
  run: (input: string) => Promise<MarketplaceItem>
  busy: boolean
  /** `"invalid"` for unparseable input; otherwise the resolver error message. */
  error: string | null
  clearError: () => void
}

export const URL_INSTALL_INVALID = "invalid"

export function useUrlInstall(): UseUrlInstall {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (input: string) => {
    setError(null)
    const ref = parseSkillsShInput(input)
    if (ref.kind === "invalid") {
      setError(URL_INSTALL_INVALID)
      throw new Error(URL_INSTALL_INVALID)
    }
    setBusy(true)
    try {
      const { item } = await resolveSkillsShRef(ref)
      await installMarketplaceItem(item)
      return item
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err
    } finally {
      setBusy(false)
    }
  }, [])

  return { run, busy, error, clearError: () => setError(null) }
}
