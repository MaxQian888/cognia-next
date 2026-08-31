"use client"

import { useEffect, useRef } from "react"
import { migrateVectorCredentials } from "@cognia/vector/migrations/credential-migration"
import { registerExistingTwinVectorBackend } from "@/lib/db/twin-runtime-settings"
import { isTauri } from "@/lib/tauri"
import { useVectorStore } from "@/stores/vector/vector-store"

export function VectorCredentialMigrationInitializer() {
  const started = useRef(false)

  useEffect(() => {
    if (started.current || !isTauri()) return
    started.current = true
    void (async () => {
      const result = await migrateVectorCredentials()
      if (result.ran) await useVectorStore.persist.rehydrate()
      // Run after migration/rehydration because both paths persist the shared
      // vector settings and must not race a stale localStorage snapshot.
      await registerExistingTwinVectorBackend()
    })().catch(() => undefined)
  }, [])

  return null
}

export default VectorCredentialMigrationInitializer
