"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { scanAndRegisterLocalPacks } from "@/lib/plugin/character-pack/local-pack-store"
import { loggers } from "@cognia/logging"

const log = loggers.plugin

/**
 * Boot-time initializer for locally-imported character packs (ADR-0030).
 *
 * Scans `<appData>/cognia/local-character-packs/` on first paint and
 * registers every valid `.cognia-pack.json` into the in-memory
 * character-pack registry. Subsequent imports / deletions update the
 * registry directly — we don't re-scan on every state change.
 *
 * When the scan skips a file (invalid JSON, schema mismatch, missing
 * required fields), we surface a toast so the user knows something is
 * wrong rather than silently logging — the file is on their disk and
 * they likely expect to see it in the Settings list. The toast points
 * at the logger for the specific reasons. (ADR-0030 §risks #5)
 *
 * No-op in web mode (the local-pack store returns an empty result when
 * `appDataDir()` can't be resolved). Following the
 * `ExternalAgentInitializer` shape so the entry under
 * `app/layout.tsx` stays homogeneous.
 */
export function LocalCharacterPackInitializer() {
  const hasInitialized = useRef(false)
  const t = useTranslations("settings.characters")

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    const initialize = async () => {
      try {
        const result = await scanAndRegisterLocalPacks()
        if (result.signatureSkipped > 0) {
          // Distinct from the generic malformed-file case, and sterner: a
          // signed pack that fails verification means the file was altered
          // after signing, not that someone mistyped some JSON.
          log.warn("local-pack-store: signed packs failed verification", {
            count: result.signatureSkipped,
          })
          toast.error(t("trust.skippedSignature", { count: result.signatureSkipped }))
        }
        const otherSkipped = result.skipped.length - result.signatureSkipped
        if (otherSkipped > 0) {
          log.warn("local-pack-store: some packs were skipped during boot scan", {
            skipped: result.skipped,
          })
          // Surface a toast so the user notices — local pack files on disk
          // that fail to register are otherwise invisible in the UI.
          toast.warning(t("packs.skippedToast", { count: otherSkipped }))
        }
      } catch (err) {
        log.warn("local-pack-store: boot scan threw", { err })
      }
    }

    void initialize()
  }, [t])

  return null
}

export default LocalCharacterPackInitializer
