"use client"

import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { countTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { getTwinProfile } from "@/lib/db/twin-profile"
import { observeTwinRuntimeSettings, saveTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import {
  DEFAULT_TWIN_RUNTIME_SETTINGS,
  type TwinRuntimeSettings,
  type VectorBackend,
} from "@/types/twin"

const VECTOR_BACKENDS: VectorBackend[] = ["qdrant", "pinecone", "weaviate", "milvus", "chroma"]

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
      <RuntimeConfigCard />
    </div>
  )
}

function RuntimeConfigCard() {
  const live = useLiveQuery(() => observeTwinRuntimeSettings(), [], DEFAULT_TWIN_RUNTIME_SETTINGS)
  // Local form state defaults to the live value. The `dirtyRef` guard prevents
  // pending edits from being clobbered by a `live` update fired by an
  // unrelated tab; once the user saves, we clear the dirty flag and let
  // `live` resume driving the form.
  const [settings, setSettings] = useState<TwinRuntimeSettings>(live)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const dirtyRef = useRef(false)

  // Sync the form whenever Dexie reports new settings AND the user hasn't
  // started editing locally. Side-effects only — no setState during render.
  useEffect(() => {
    if (dirtyRef.current) return
    setSettings(live)
  }, [live])

  const updateField = (next: TwinRuntimeSettings) => {
    dirtyRef.current = true
    setSettings(next)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveTwinRuntimeSettings(settings)
      dirtyRef.current = false
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Runtime configuration</h3>
        {savedAt ? (
          <span className="text-muted-foreground text-xs">
            saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        ) : null}
      </header>

      <div className="flex items-center gap-3">
        <Switch
          id="twin-worker-enabled"
          checked={settings.workerEnabled}
          onCheckedChange={(v) => updateField({ ...settings, workerEnabled: v })}
        />
        <Label htmlFor="twin-worker-enabled" className="text-sm">
          Auto-start the job worker for this twin
        </Label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FieldGroup
          legend="Embedding"
          fields={[
            {
              label: "Provider",
              kind: "select",
              value: settings.embedding.provider,
              options: ["openai", "google", "cohere", "mistral", "transformersjs"],
              onChange: (v) =>
                updateField({
                  ...settings,
                  embedding: {
                    ...settings.embedding,
                    provider: v as TwinRuntimeSettings["embedding"]["provider"],
                  },
                }),
            },
            {
              label: "Model",
              kind: "input",
              value: settings.embedding.model,
              onChange: (v) =>
                updateField({ ...settings, embedding: { ...settings.embedding, model: v } }),
            },
            {
              label: "API key",
              kind: "secret",
              value: settings.embedding.apiKey,
              onChange: (v) =>
                updateField({ ...settings, embedding: { ...settings.embedding, apiKey: v } }),
            },
          ]}
        />

        <FieldGroup
          legend="Distill LLM"
          fields={[
            {
              label: "Model",
              kind: "input",
              value: settings.llm.model,
              onChange: (v) => updateField({ ...settings, llm: { ...settings.llm, model: v } }),
            },
            {
              label: "API key",
              kind: "secret",
              value: settings.llm.apiKey,
              onChange: (v) => updateField({ ...settings, llm: { ...settings.llm, apiKey: v } }),
            },
          ]}
        />
      </div>

      <fieldset className="border-border flex flex-col gap-3 rounded border p-3">
        <legend className="text-muted-foreground px-1 text-xs uppercase tracking-wide">
          Vector store
        </legend>
        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-vector-backend">Backend</Label>
          <select
            id="twin-vector-backend"
            className="border-border bg-background h-9 rounded border px-2 text-sm"
            value={settings.storage.vectorBackend}
            onChange={(e) =>
              updateField({
                ...settings,
                storage: { ...settings.storage, vectorBackend: e.target.value as VectorBackend },
              })
            }
          >
            {VECTOR_BACKENDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <BackendSpecificFields
          settings={settings}
          onPatch={(patch) =>
            updateField({ ...settings, storage: { ...settings.storage, ...patch } })
          }
        />
      </fieldset>

      <div className="flex items-center justify-end gap-2">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save runtime settings"}
        </Button>
      </div>
    </Card>
  )
}

interface BackendFieldsProps {
  settings: TwinRuntimeSettings
  onPatch: (patch: Partial<TwinRuntimeSettings["storage"]>) => void
}

function BackendSpecificFields({ settings, onPatch }: BackendFieldsProps) {
  const backend = settings.storage.vectorBackend
  if (backend === "qdrant") {
    const qdrant = settings.storage.qdrant ?? { url: "" }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="URL"
          value={qdrant.url}
          onChange={(v) => onPatch({ qdrant: { ...qdrant, url: v } })}
        />
        <Field
          label="API key (optional)"
          secret
          value={qdrant.apiKey ?? ""}
          onChange={(v) => onPatch({ qdrant: { ...qdrant, apiKey: v || undefined } })}
        />
      </div>
    )
  }
  if (backend === "pinecone") {
    const p = settings.storage.pinecone ?? { apiKey: "", indexName: "" }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="API key"
          secret
          value={p.apiKey}
          onChange={(v) => onPatch({ pinecone: { ...p, apiKey: v } })}
        />
        <Field
          label="Index name"
          value={p.indexName}
          onChange={(v) => onPatch({ pinecone: { ...p, indexName: v } })}
        />
        <Field
          label="Namespace"
          value={p.namespace ?? ""}
          onChange={(v) => onPatch({ pinecone: { ...p, namespace: v || undefined } })}
        />
      </div>
    )
  }
  if (backend === "weaviate") {
    const w = settings.storage.weaviate ?? { url: "" }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="URL"
          value={w.url}
          onChange={(v) => onPatch({ weaviate: { ...w, url: v } })}
        />
        <Field
          label="API key (optional)"
          secret
          value={w.apiKey ?? ""}
          onChange={(v) => onPatch({ weaviate: { ...w, apiKey: v || undefined } })}
        />
      </div>
    )
  }
  if (backend === "milvus") {
    const m = settings.storage.milvus ?? { address: "" }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Address"
          value={m.address}
          onChange={(v) => onPatch({ milvus: { ...m, address: v } })}
        />
        <Field
          label="Token (optional)"
          secret
          value={m.token ?? ""}
          onChange={(v) => onPatch({ milvus: { ...m, token: v || undefined } })}
        />
      </div>
    )
  }
  if (backend === "chroma") {
    const c = settings.storage.chroma ?? { mode: "embedded" }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label>Mode</Label>
          <select
            className="border-border bg-background h-9 rounded border px-2 text-sm"
            value={c.mode}
            onChange={(e) =>
              onPatch({ chroma: { ...c, mode: e.target.value as "embedded" | "server" } })
            }
          >
            <option value="embedded">embedded</option>
            <option value="server">server</option>
          </select>
        </div>
        {c.mode === "server" ? (
          <Field
            label="Server URL"
            value={c.serverUrl ?? ""}
            onChange={(v) => onPatch({ chroma: { ...c, serverUrl: v || undefined } })}
          />
        ) : null}
      </div>
    )
  }
  return null
}

interface FieldDef {
  label: string
  kind: "input" | "secret" | "select"
  value: string
  options?: readonly string[]
  onChange: (v: string) => void
}

function FieldGroup({ legend, fields }: { legend: string; fields: FieldDef[] }) {
  return (
    <fieldset className="border-border flex flex-col gap-3 rounded border p-3">
      <legend className="text-muted-foreground px-1 text-xs uppercase tracking-wide">
        {legend}
      </legend>
      {fields.map((field) => (
        <div key={field.label} className="flex flex-col gap-1">
          <Label>{field.label}</Label>
          {field.kind === "select" && field.options ? (
            <select
              className="border-border bg-background h-9 rounded border px-2 text-sm"
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
            >
              {field.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type={field.kind === "secret" ? "password" : "text"}
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
            />
          )}
        </div>
      ))}
    </fieldset>
  )
}

function Field({
  label,
  value,
  onChange,
  secret = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  secret?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <Input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
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
