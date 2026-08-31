"use client"

import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { countTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { getTwinProfile } from "@/lib/db/twin-profile"
import { observeTwinRuntimeSettings, saveTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { isTauri } from "@/lib/utils"
import { usePlatform } from "@/hooks/use-platform"
import { revealInExplorer } from "@/lib/tauri/opener"
import { verifyVectorBackendReadiness } from "@cognia/vector/readiness"
import {
  RAG_EMBEDDING_PROVIDERS,
  embeddingProviderRequiresApiKey,
  embeddingProviderRequiresBaseURL,
} from "@cognia/provider-embedding/embedding-catalog"
import type { StorageBackendReadinessState } from "@/lib/storage/persistence/types"
import {
  DEFAULT_TWIN_RUNTIME_SETTINGS,
  type TwinRuntimeSettings,
  type VectorBackend,
} from "@/types/twin"
import { TwinOverviewCard } from "./twin-overview-card"
import { TwinCronCard } from "./twin-cron-card"
import { TwinInjectLogCard } from "./twin-inject-log-card"
import { TwinSettingsPluginSlot } from "./twin-plugin-slots"
import { deriveTwinVectorStoreConfig } from "@/lib/twin/runtime/build-deps"
import { isTwinWorkerConfigComplete } from "@/lib/twin/worker-runtime"

const VECTOR_BACKENDS: VectorBackend[] = [
  "qdrant",
  "pinecone",
  "weaviate",
  "milvus",
  "chroma",
  "native",
]

// Distill LLM providers wired through `createLlmClient` (lib/twin/distill/llm.ts).
const DISTILL_LLM_PROVIDERS = ["anthropic", "openai", "google", "mistral", "cohere"] as const

export function TwinSettingsTab({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.settings")
  const sourceCount = useLiveQuery(
    async () => (await listTwinSourcesByTwin(twinId)).length,
    [twinId],
    0
  )
  const chunkCount = useLiveQuery(() => countTwinChunksByTwin(twinId), [twinId], 0)
  const profile = useLiveQuery(() => getTwinProfile(twinId), [twinId], undefined)

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">{t("title")}</h2>
      <Card className="grid gap-3 p-4 @sm/twin:grid-cols-2 @md/twin:grid-cols-3 @lg/twin:grid-cols-4">
        <Stat label={t("statsTwinId")} value={twinId} mono />
        <Stat label={t("statsSources")} value={String(sourceCount)} />
        <Stat label={t("statsChunks")} value={String(chunkCount)} />
        <Stat label={t("statsStyleSamples")} value={String(profile?.styleSamples.length ?? 0)} />
        <Stat label={t("statsPlaybooks")} value={String(profile?.playbooks.length ?? 0)} />
        <Stat label={t("statsEntities")} value={String(profile?.entities.length ?? 0)} />
        <Stat
          label={t("statsVoiceSummary")}
          value={profile?.voiceSummary?.slice(0, 80) || t("voiceEmpty")}
        />
        <Stat
          label={t("statsProfileUpdated")}
          value={profile?.updatedAt ? new Date(profile.updatedAt).toLocaleString() : t("never")}
        />
      </Card>
      <TwinOverviewCard twinId={twinId} />
      <TwinCronCard twinId={twinId} />
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-medium">{t("ragDefaultsTitle")}</h3>
        <p className="text-muted-foreground text-xs">{t("ragDefaultsBody")}</p>
      </Card>
      <RuntimeConfigCard />
      <TwinInjectLogCard twinId={twinId} />
      <TwinSettingsPluginSlot twinId={twinId} />
    </div>
  )
}

function RuntimeConfigCard() {
  const t = useTranslations("twin.settings")
  const live = useLiveQuery(() => observeTwinRuntimeSettings(), [], DEFAULT_TWIN_RUNTIME_SETTINGS)
  // Local form state defaults to the live value. The `dirtyRef` guard prevents
  // pending edits from being clobbered by a `live` update fired by an
  // unrelated tab; once the user saves, we clear the dirty flag and let
  // `live` resume driving the form.
  const [settings, setSettings] = useState<TwinRuntimeSettings>(live)
  // Raw textarea text for extraNameHints — kept separate from the parsed
  // array so in-progress separators ("Alice, ") aren't normalized away on
  // every keystroke by a join/split round-trip.
  const [nameHintsText, setNameHintsText] = useState(live.extraNameHints.join(", "))
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const dirtyRef = useRef(false)

  // Hide the "native" option when not running under Tauri — it requires
  // the Tauri IPC bridge and will never work in the web browser.
  const platform = usePlatform()
  const workerConfigurationIncomplete =
    platform === "tauri" && settings.workerEnabled && !isTwinWorkerConfigComplete(settings)
  // Sync the form whenever Dexie reports new settings AND the user hasn't
  // started editing locally. Side-effects only — no setState during render.
  useEffect(() => {
    if (dirtyRef.current) return
    setSettings(live)
    setNameHintsText(live.extraNameHints.join(", "))
  }, [live])

  const updateField = (next: TwinRuntimeSettings) => {
    dirtyRef.current = true
    setSettings(next)
  }

  const persistSettings = async (): Promise<boolean> => {
    setSaving(true)
    try {
      await saveTwinRuntimeSettings(settings)
      dirtyRef.current = false
      setSavedAt(Date.now())
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t("saveFailed", { message }))
      return false
    } finally {
      setSaving(false)
    }
  }

  const embeddingProvider = settings.embedding.provider
  const embeddingFields: FieldDef[] = [
    {
      label: t("provider"),
      kind: "select",
      value: embeddingProvider,
      options: RAG_EMBEDDING_PROVIDERS,
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
      label: t("model"),
      kind: "input",
      value: settings.embedding.model,
      onChange: (v) => updateField({ ...settings, embedding: { ...settings.embedding, model: v } }),
    },
    // Base URL only for local engines (ollama/lmstudio/…) + proxy overrides.
    ...(embeddingProviderRequiresBaseURL(embeddingProvider)
      ? ([
          {
            label: t("baseURL"),
            kind: "input",
            value: settings.embedding.baseURL ?? "",
            onChange: (v: string) =>
              updateField({ ...settings, embedding: { ...settings.embedding, baseURL: v } }),
          },
        ] as FieldDef[])
      : []),
    // API key only for cloud providers; local engines need none.
    ...(embeddingProviderRequiresApiKey(embeddingProvider)
      ? ([
          {
            label: t("apiKey"),
            kind: "secret",
            value: settings.embedding.apiKey,
            onChange: (v: string) =>
              updateField({ ...settings, embedding: { ...settings.embedding, apiKey: v } }),
          },
        ] as FieldDef[])
      : []),
  ]

  const distillFields: FieldDef[] = [
    {
      label: t("provider"),
      kind: "select",
      value: settings.llm.provider,
      options: DISTILL_LLM_PROVIDERS,
      onChange: (v) =>
        updateField({
          ...settings,
          llm: { ...settings.llm, provider: v as TwinRuntimeSettings["llm"]["provider"] },
        }),
    },
    {
      label: t("model"),
      kind: "input",
      value: settings.llm.model,
      onChange: (v) => updateField({ ...settings, llm: { ...settings.llm, model: v } }),
    },
    {
      label: t("baseURL"),
      kind: "input",
      value: settings.llm.baseURL ?? "",
      onChange: (v) => updateField({ ...settings, llm: { ...settings.llm, baseURL: v } }),
    },
    {
      label: t("apiKey"),
      kind: "secret",
      value: settings.llm.apiKey,
      onChange: (v) => updateField({ ...settings, llm: { ...settings.llm, apiKey: v } }),
    },
  ]

  return (
    <Card className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-1 @sm/twin:flex-row @sm/twin:items-center @sm/twin:justify-between">
        <h3 className="text-sm font-medium">{t("runtimeTitle")}</h3>
        {savedAt ? (
          <span className="text-muted-foreground text-xs">
            {t("savedAt", { when: new Date(savedAt).toLocaleTimeString() })}
          </span>
        ) : null}
      </header>

      <div className="flex items-center gap-3">
        <Switch
          id="twin-worker-enabled"
          checked={settings.workerEnabled}
          disabled={platform !== "tauri"}
          onCheckedChange={(v) => updateField({ ...settings, workerEnabled: v })}
        />
        <Label htmlFor="twin-worker-enabled" className="text-sm">
          {t("workerToggleLabel")}
        </Label>
      </div>
      {platform !== "tauri" ? (
        <p className="text-muted-foreground text-xs">{t("workerDesktopOnly")}</p>
      ) : null}

      <div className="flex items-center gap-3">
        <Switch
          id="twin-reranker-enabled"
          checked={settings.reranker?.enabled ?? false}
          onCheckedChange={(v) =>
            updateField({
              ...settings,
              reranker: { enabled: v, model: settings.reranker?.model ?? "lexical" },
            })
          }
        />
        <Label htmlFor="twin-reranker-enabled" className="text-sm">
          {t("rerankerToggleLabel")}
        </Label>
        <span className="text-muted-foreground text-xs">{t("rerankerToggleHint")}</span>
      </div>

      <div className="flex items-center gap-3">
        <Switch
          id="twin-query-expansion-enabled"
          checked={settings.queryExpansion?.enabled ?? false}
          onCheckedChange={(v) =>
            updateField({
              ...settings,
              queryExpansion: {
                enabled: v,
                strategy: settings.queryExpansion?.strategy ?? "hyde",
              },
            })
          }
        />
        <Label htmlFor="twin-query-expansion-enabled" className="text-sm">
          {t("queryExpansionToggleLabel")}
        </Label>
        <span className="text-muted-foreground text-xs">{t("queryExpansionToggleHint")}</span>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="twin-extra-name-hints">{t("extraNameHintsLabel")}</Label>
        <Textarea
          id="twin-extra-name-hints"
          data-testid="twin-settings-extra-name-hints"
          value={nameHintsText}
          placeholder={t("extraNameHintsPlaceholder")}
          rows={2}
          onChange={(e) => {
            setNameHintsText(e.target.value)
            updateField({
              ...settings,
              extraNameHints: e.target.value
                .split(/[,\n]/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }}
        />
        <span className="text-muted-foreground text-xs">{t("extraNameHintsHelp")}</span>
      </div>

      {settings.reranker?.enabled ? (
        <div className="flex flex-col gap-1 pl-11">
          <Label htmlFor="twin-reranker-model">{t("rerankerModelLabel")}</Label>
          <Select
            value={settings.reranker?.model ?? "lexical"}
            onValueChange={(next) =>
              updateField({
                ...settings,
                reranker: { enabled: true, model: next },
              })
            }
          >
            <SelectTrigger
              id="twin-reranker-model"
              aria-label={t("rerankerModelLabel")}
              className="w-full @sm/twin:w-[16rem]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lexical">{t("rerankerModelLexical")}</SelectItem>
              <SelectItem value="llm">{t("rerankerModelLlm")}</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-muted-foreground text-xs">{t("rerankerModelHint")}</span>
        </div>
      ) : null}

      {settings.queryExpansion?.enabled ? (
        <div className="flex flex-col gap-1 pl-11">
          <Label htmlFor="twin-query-expansion-strategy">{t("queryExpansionStrategyLabel")}</Label>
          <Select
            value={settings.queryExpansion?.strategy ?? "hyde"}
            onValueChange={(next) =>
              updateField({
                ...settings,
                queryExpansion: { enabled: true, strategy: next as "hyde" | "stepback" },
              })
            }
          >
            <SelectTrigger
              id="twin-query-expansion-strategy"
              aria-label={t("queryExpansionStrategyLabel")}
              className="w-full @sm/twin:w-[16rem]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hyde">{t("queryExpansionStrategyHyde")}</SelectItem>
              <SelectItem value="stepback">{t("queryExpansionStrategyStepback")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="grid gap-3 @md/twin:grid-cols-2">
        <FieldGroup legend={t("embedding")} fields={embeddingFields} />

        <FieldGroup legend={t("distillLlm")} fields={distillFields} />
      </div>

      {platform === "tauri" ? (
        <fieldset className="border-border flex min-w-0 flex-col gap-3 rounded border p-3">
          <legend className="text-muted-foreground px-1 text-xs uppercase tracking-wide">
            {t("vectorStore")}
          </legend>
          <div className="flex flex-col gap-1">
            <Label htmlFor="twin-vector-backend">{t("backend")}</Label>
            <Select
              value={settings.storage.vectorBackend}
              onValueChange={(next) =>
                updateField({
                  ...settings,
                  storage: {
                    ...settings.storage,
                    vectorBackend: next as VectorBackend,
                  },
                })
              }
            >
              <SelectTrigger
                id="twin-vector-backend"
                aria-label={t("backend")}
                className="w-full @sm/twin:w-[16rem]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VECTOR_BACKENDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {t(`backendDisplay.${b}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <BackendSpecificFields
            settings={settings}
            onPatch={(patch) =>
              updateField({ ...settings, storage: { ...settings.storage, ...patch } })
            }
          />
          <VectorBackendReadiness
            settings={settings}
            saving={saving}
            persistSettings={persistSettings}
          />
        </fieldset>
      ) : (
        <fieldset className="border-border rounded border p-3">
          <legend className="text-muted-foreground px-1 text-xs uppercase tracking-wide">
            {t("vectorStore")}
          </legend>
          <p className="text-muted-foreground text-xs">{t("vectorDesktopOnly")}</p>
        </fieldset>
      )}

      <div className="flex flex-col gap-2 @xs/twin:flex-row @xs/twin:items-center @xs/twin:justify-end">
        {workerConfigurationIncomplete ? (
          <p className="text-destructive text-xs">{t("workerConfigurationIncomplete")}</p>
        ) : null}
        <Button
          onClick={() => void persistSettings()}
          disabled={saving || workerConfigurationIncomplete}
        >
          {saving ? (
            <>
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              {t("saving")}
            </>
          ) : (
            t("save")
          )}
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
  const t = useTranslations("twin.settings")
  const backend = settings.storage.vectorBackend
  if (backend === "qdrant") {
    const qdrant = settings.storage.qdrant ?? { url: "" }
    return (
      <div className="grid gap-3 @sm/twin:grid-cols-2">
        <Field
          label={t("url")}
          value={qdrant.url}
          onChange={(v) => onPatch({ qdrant: { ...qdrant, url: v } })}
        />
        <Field
          label={t("apiKeyOptional")}
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
      <div className="grid gap-3 @sm/twin:grid-cols-2">
        <Field
          label={t("apiKey")}
          secret
          value={p.apiKey}
          onChange={(v) => onPatch({ pinecone: { ...p, apiKey: v } })}
        />
        <Field
          label={t("indexName")}
          value={p.indexName}
          onChange={(v) => onPatch({ pinecone: { ...p, indexName: v } })}
        />
        <Field
          label={t("namespace")}
          value={p.namespace ?? ""}
          onChange={(v) => onPatch({ pinecone: { ...p, namespace: v || undefined } })}
        />
      </div>
    )
  }
  if (backend === "weaviate") {
    const w = settings.storage.weaviate ?? { url: "" }
    return (
      <div className="grid gap-3 @sm/twin:grid-cols-2">
        <Field
          label={t("url")}
          value={w.url}
          onChange={(v) => onPatch({ weaviate: { ...w, url: v } })}
        />
        <Field
          label={t("apiKeyOptional")}
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
      <div className="grid gap-3 @sm/twin:grid-cols-2">
        <Field
          label={t("address")}
          value={m.address}
          onChange={(v) => onPatch({ milvus: { ...m, address: v } })}
        />
        <Field
          label={t("tokenOptional")}
          secret
          value={m.token ?? ""}
          onChange={(v) => onPatch({ milvus: { ...m, token: v || undefined } })}
        />
      </div>
    )
  }
  if (backend === "chroma") {
    const c = settings.storage.chroma ?? { mode: "server" }
    // Embedded Chroma is retired. A row persisted under it points at nothing a
    // server URL could replace, and `deriveTwinVectorStoreConfig` now returns
    // null for it — so say that plainly instead of leaving the user with an
    // empty field and a silently stopped worker. The mode normalises to
    // "server" on the first edit below.
    const retiredEmbedded = c.mode === "embedded"
    return (
      <div className="space-y-1">
        {retiredEmbedded ? (
          <p className="text-destructive text-xs" role="status">
            {t("chromaEmbeddedRetired")}
          </p>
        ) : null}
        <Field
          label={t("serverUrl")}
          value={c.serverUrl ?? ""}
          onChange={(v) => onPatch({ chroma: { ...c, mode: "server", serverUrl: v || undefined } })}
        />
        <p className="text-muted-foreground text-xs">{t("chromaServerOnly")}</p>
      </div>
    )
  }
  if (backend === "native") {
    return <NativeBackendFields />
  }
  return null
}

// ─── Native backend controls ──────────────────────────────────────────────────

type ReadinessState = StorageBackendReadinessState | null

function stateVariant(state: ReadinessState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "operational") return "default"
  if (state === "reachable" || state === "configured") return "secondary"
  if (state === "unconfigured") return "outline"
  return "destructive"
}

function NativeBackendFields() {
  const t = useTranslations("twin.settings")

  const handleOpenFolder = async () => {
    if (!isTauri()) return
    try {
      const { appDataDir, join } = await import("@tauri-apps/api/path")
      const base = await appDataDir()
      // Reveal the vectors.sqlite file — the OS file manager will highlight
      // the file inside its containing folder (cognia/).
      const filePath = await join(base, "cognia", "vectors.sqlite")
      await revealInExplorer(filePath)
    } catch {
      // No-op: if Tauri isn't available or the path doesn't exist yet, silently
      // skip — the file might not exist until the first vector write.
    }
  }

  const handleReset = async () => {
    try {
      await invoke("vector_reset_store")
      toast.success(t("resetSuccess"))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t("resetFailed", { msg }))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">{t("nativeDescription")}</p>

      {/* Open data folder */}
      <Button variant="outline" size="sm" onClick={() => void handleOpenFolder()}>
        {t("openDataFolder")}
      </Button>

      {/* Reset vector store (two-step confirm) */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm">
            {t("resetButton")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resetDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("resetDialogBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleReset()}>
              {t("confirmReset")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function VectorBackendReadiness({
  settings,
  saving,
  persistSettings,
}: {
  settings: TwinRuntimeSettings
  saving: boolean
  persistSettings: () => Promise<boolean>
}) {
  const t = useTranslations("twin.settings")
  const [testLoading, setTestLoading] = useState(false)
  const [testState, setTestState] = useState<ReadinessState>(null)
  const [testCode, setTestCode] = useState<string | undefined>(undefined)
  const config = deriveTwinVectorStoreConfig(settings, { requireEmbeddingCredentials: false })

  const handleTestConnection = async () => {
    if (!config) return
    setTestLoading(true)
    setTestState(null)
    setTestCode(undefined)
    try {
      if (!(await persistSettings())) return
      const result = await verifyVectorBackendReadiness(config)
      setTestState(result.state)
      setTestCode(result.diagnostic?.code)
    } catch {
      setTestState("degraded")
    } finally {
      setTestLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3 @sm/twin:flex-row @sm/twin:items-center">
      <Button
        variant="outline"
        size="sm"
        className="w-full @sm/twin:w-auto"
        onClick={() => void handleTestConnection()}
        disabled={saving || testLoading || !config}
      >
        {testLoading ? (
          <>
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
            {t("testing")}
          </>
        ) : (
          t("saveAndTestConnection")
        )}
      </Button>
      {!config ? (
        <p className="text-muted-foreground text-xs">{t("completeVectorConfiguration")}</p>
      ) : null}
      {testState !== null ? (
        <Badge variant={stateVariant(testState)} className="w-fit max-w-full break-all">
          {t(`readiness.${testState}`)}
          {testCode ? ` — ${testCode}` : ""}
        </Badge>
      ) : null}
    </div>
  )
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
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger aria-label={field.label} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
