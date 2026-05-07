"use client"

/**
 * Character ↔ Digital twin binding panel.
 *
 * Lives inside the character editor (`CharactersSection`) so the user can
 * link a character to a twin without dropping into the workbench. Two
 * states:
 *
 *   1. **Unbound** — single Bind button + "Create new twin" affordance.
 *      Selecting an existing twin from the list immediately writes
 *      `editorState.twinId` and reveals the runtime knobs.
 *   2. **Bound** — twin id, live profile stats, four runtime knobs (RAG
 *      enable, top-K, style few-shot enable, samples-K), and a deep link
 *      into the twin workbench. The "Unbind" button clears `twinId` +
 *      `twinSettings`.
 *
 * Stat rendering uses Dexie liveQuery so the user sees the numbers in
 * real time even if the workbench is processing chunks in another tab.
 */

import { useMemo, useState } from "react"
import Link from "next/link"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, LinkIcon, Link2OffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listCharacters } from "@/lib/db/characters"
import { countTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { getTwinProfile } from "@/lib/db/twin-profile"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { DEFAULT_TWIN_SETTINGS, type TwinSettings } from "@/types/twin"

export interface TwinBindingValue {
  twinId?: string
  twinSettings?: Partial<TwinSettings>
}

interface Props {
  /** Current binding (read from `EditorState`). */
  value: TwinBindingValue
  /** Patches the parent editor's `twinId` + `twinSettings` fields. */
  onChange: (next: TwinBindingValue) => void
  /** Optional id of the character being edited — excluded from the dropdown
   *  to avoid self-loops in the "use existing twin" picker. */
  excludeCharacterId?: string
}

function suggestTwinId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `twin_${random}`
}

export function TwinBindingSection({ value, onChange, excludeCharacterId }: Props) {
  const t = useTranslations("settings.characters.editor.twinBinding")

  // Discover existing twin ids from other characters. We deliberately omit
  // *this* character (avoid self-referential confusion when the user is
  // mid-edit) but include orphaned twins (ids whose owner was deleted) by
  // walking `twinSources` distinct twinId values.
  const knownTwinIds = useLiveQuery(
    async () => {
      const seen = new Set<string>()
      const characters = await listCharacters()
      for (const c of characters) {
        if (!c.twinId) continue
        if (excludeCharacterId && c.id === excludeCharacterId) continue
        seen.add(c.twinId)
      }
      return Array.from(seen).sort()
    },
    [excludeCharacterId],
    [] as string[]
  )

  const isBound = Boolean(value.twinId)
  const settings: TwinSettings = useMemo(
    () => ({
      enableRag: value.twinSettings?.enableRag ?? DEFAULT_TWIN_SETTINGS.enableRag,
      ragTopK: value.twinSettings?.ragTopK ?? DEFAULT_TWIN_SETTINGS.ragTopK,
      enableStyleFewShot:
        value.twinSettings?.enableStyleFewShot ?? DEFAULT_TWIN_SETTINGS.enableStyleFewShot,
      styleSamplesK: value.twinSettings?.styleSamplesK ?? DEFAULT_TWIN_SETTINGS.styleSamplesK,
    }),
    [value.twinSettings]
  )

  const updateSettings = (patch: Partial<TwinSettings>) => {
    onChange({ ...value, twinSettings: { ...settings, ...patch } })
  }

  if (!isBound) {
    return (
      <UnboundCard
        knownTwinIds={knownTwinIds}
        onBind={(twinId) => onChange({ twinId, twinSettings: DEFAULT_TWIN_SETTINGS })}
        t={t}
      />
    )
  }

  return (
    <Card className="space-y-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="flex items-center gap-2 text-sm">
            <LinkIcon className="size-3.5" aria-hidden />
            {t("titleBound")}
          </Label>
          <code className="text-muted-foreground font-mono text-[11px]">{value.twinId}</code>
        </div>
        <div className="flex items-center gap-1">
          <Button asChild variant="outline" size="sm">
            <Link href={`/twin?twinId=${encodeURIComponent(value.twinId!)}`} target="_blank">
              <ExternalLinkIcon className="mr-1 size-3" aria-hidden />
              {t("openWorkbench")}
            </Link>
          </Button>
          <UnbindButton
            t={t}
            onConfirm={() => onChange({ twinId: undefined, twinSettings: undefined })}
          />
        </div>
      </header>

      <TwinStatsStrip twinId={value.twinId!} t={t} />

      <RuntimeKnobs t={t} settings={settings} onChange={updateSettings} />
    </Card>
  )
}

// ─── Unbound state ────────────────────────────────────────────────────────────

function UnboundCard({
  knownTwinIds,
  onBind,
  t,
}: {
  knownTwinIds: string[]
  onBind: (twinId: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const [creating, setCreating] = useState(false)
  const [pendingId, setPendingId] = useState(suggestTwinId())

  return (
    <Card className="space-y-3 p-4">
      <div className="space-y-1">
        <Label className="flex items-center gap-2 text-sm">
          <LinkIcon className="size-3.5" aria-hidden />
          {t("titleUnbound")}
        </Label>
        <p className="text-muted-foreground text-xs">{t("unboundDescription")}</p>
      </div>

      {knownTwinIds.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs">{t("pickExisting")}</Label>
          <Select onValueChange={(v) => onBind(v)} value="">
            <SelectTrigger>
              <SelectValue placeholder={t("pickExistingPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {knownTwinIds.map((id) => (
                <SelectItem key={id} value={id}>
                  <span className="font-mono text-xs">{id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {!creating ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPendingId(suggestTwinId())
            setCreating(true)
          }}
        >
          {t("createNew")}
        </Button>
      ) : (
        <div className="bg-muted/30 space-y-2 rounded-md border p-3">
          <Label className="text-xs">{t("newTwinId")}</Label>
          <Input
            value={pendingId}
            onChange={(e) => setPendingId(e.target.value.trim())}
            className="font-mono text-xs"
            placeholder={t("newTwinIdPlaceholder")}
            spellCheck={false}
          />
          <p className="text-muted-foreground text-[11px]">{t("newTwinIdHint")}</p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!pendingId}
              onClick={() => {
                if (pendingId) onBind(pendingId)
                setCreating(false)
              }}
            >
              {t("confirmBind")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ─── Stats strip (live) ───────────────────────────────────────────────────────

function TwinStatsStrip({ twinId, t }: { twinId: string; t: ReturnType<typeof useTranslations> }) {
  const sources = useLiveQuery(
    async () => (await listTwinSourcesByTwin(twinId)).length,
    [twinId],
    0
  )
  const chunks = useLiveQuery(() => countTwinChunksByTwin(twinId), [twinId], 0)
  const profile = useLiveQuery(() => getTwinProfile(twinId), [twinId], undefined)
  const styleSamples = profile?.styleSamples.length ?? 0
  const playbooks = profile?.playbooks.length ?? 0
  const lastDistilled = profile?.updatedAt
    ? new Date(profile.updatedAt).toLocaleString()
    : t("never")

  return (
    <div className="bg-muted/40 grid grid-cols-2 gap-3 rounded-md border p-3 sm:grid-cols-4">
      <Stat label={t("statsSources")} value={String(sources)} />
      <Stat label={t("statsChunks")} value={String(chunks)} />
      <Stat label={t("statsStyleSamples")} value={String(styleSamples)} />
      <Stat label={t("statsPlaybooks")} value={String(playbooks)} />
      <div className="col-span-2 sm:col-span-4">
        <Stat label={t("statsLastDistilled")} value={lastDistilled} small />
      </div>
    </div>
  )
}

function Stat({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</span>
      <span className={small ? "text-xs" : "text-sm font-medium"}>{value}</span>
    </div>
  )
}

// ─── Runtime knobs (RAG + style few-shot) ─────────────────────────────────────

function RuntimeKnobs({
  t,
  settings,
  onChange,
}: {
  t: ReturnType<typeof useTranslations>
  settings: TwinSettings
  onChange: (patch: Partial<TwinSettings>) => void
}) {
  return (
    <div className="space-y-3">
      <Label className="text-xs uppercase tracking-wide">{t("runtimeTitle")}</Label>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor="twin-enable-rag" className="cursor-pointer text-sm">
            {t("enableRag")}
          </Label>
          <p className="text-muted-foreground text-[11px]">{t("enableRagHint")}</p>
        </div>
        <Switch
          id="twin-enable-rag"
          checked={settings.enableRag}
          onCheckedChange={(v) => onChange({ enableRag: v })}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("ragTopK")}</Label>
          <span className="text-muted-foreground text-xs tabular-nums">{settings.ragTopK}</span>
        </div>
        <Slider
          min={1}
          max={20}
          step={1}
          value={[settings.ragTopK]}
          onValueChange={(v) => onChange({ ragTopK: v[0] ?? settings.ragTopK })}
          disabled={!settings.enableRag}
          aria-label={t("ragTopK")}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor="twin-enable-fewshot" className="cursor-pointer text-sm">
            {t("enableStyleFewShot")}
          </Label>
          <p className="text-muted-foreground text-[11px]">{t("enableStyleFewShotHint")}</p>
        </div>
        <Switch
          id="twin-enable-fewshot"
          checked={settings.enableStyleFewShot}
          onCheckedChange={(v) => onChange({ enableStyleFewShot: v })}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("styleSamplesK")}</Label>
          <span className="text-muted-foreground text-xs tabular-nums">
            {settings.styleSamplesK}
          </span>
        </div>
        <Slider
          min={0}
          max={10}
          step={1}
          value={[settings.styleSamplesK]}
          onValueChange={(v) => onChange({ styleSamplesK: v[0] ?? settings.styleSamplesK })}
          disabled={!settings.enableStyleFewShot}
          aria-label={t("styleSamplesK")}
        />
      </div>
    </div>
  )
}

function UnbindButton({
  t,
  onConfirm,
}: {
  t: ReturnType<typeof useTranslations>
  onConfirm: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("unbind")}>
          <Link2OffIcon className="size-3.5" aria-hidden />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("unbindTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("unbindBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("unbindConfirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
