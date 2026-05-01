"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { Card } from "@/components/ui/card"
import { countTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { getTwinProfile } from "@/lib/db/twin-profile"

/**
 * Phase 7 ships read-only stats. Phase 8 will add the editable controls
 * (vector backend selector, per-twin RAG topK / few-shot k overrides).
 */
export function TwinSettingsTab({ twinId }: { twinId: string }) {
  const sourceCount = useLiveQuery(
    async () => (await listTwinSourcesByTwin(twinId)).length,
    [twinId],
    0
  )
  const chunkCount = useLiveQuery(() => countTwinChunksByTwin(twinId), [twinId], 0)
  const profile = useLiveQuery(() => getTwinProfile(twinId), [twinId], undefined)

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Settings</h2>
      <Card className="grid gap-3 p-4 sm:grid-cols-2">
        <Stat label="Twin id" value={twinId} mono />
        <Stat label="Sources" value={String(sourceCount)} />
        <Stat label="Indexed chunks" value={String(chunkCount)} />
        <Stat label="Style samples" value={String(profile?.styleSamples.length ?? 0)} />
        <Stat label="Playbooks" value={String(profile?.playbooks.length ?? 0)} />
        <Stat label="Entities" value={String(profile?.entities.length ?? 0)} />
        <Stat label="Voice summary" value={profile?.voiceSummary?.slice(0, 80) || "(empty)"} />
        <Stat
          label="Profile updated"
          value={profile?.updatedAt ? new Date(profile.updatedAt).toLocaleString() : "(never)"}
        />
      </Card>
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-medium">RAG defaults</h3>
        <p className="text-muted-foreground text-xs">
          Per-character overrides live on the character record (`twinSettings.ragTopK`,
          `twinSettings.styleSamplesK`). When unset, the runtime falls back to DEFAULT_TWIN_SETTINGS
          (topK = 6, styleSamplesK = 3, RAG + few-shot enabled).
        </p>
      </Card>
    </div>
  )
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      <span className={mono ? "font-mono text-sm break-all" : "text-sm"}>{value}</span>
    </div>
  )
}
