"use client"

/**
 * EntityPicker — a searchable combobox for selecting an entity id (character,
 * team, skill, workflow, MCP server, plugin, twin) inside inspector forms.
 *
 * Built on the shared `components/ui/combobox.tsx` primitive (base-ui) so it
 * gets in-list text filtering for free. An optional "use expression" toggle
 * swaps the combobox for an {@link ExpressionField}, so authors can bind a
 * `{{ … }}` value — and so the field stays usable in web mode where the
 * backing Dexie tables can be empty (no options to pick from).
 *
 * Wrappers (`CharacterPicker`, `TeamPicker`, …) keep the original
 * `{ id, value, onChange, allowEmpty? }` signature the inspector forms already
 * call, so existing call sites swap in mechanically.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Code2, ListChecks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listPlugins } from "@/lib/db/plugins"
import { listWorkflows } from "@/lib/db/workflows"
import { listTwins } from "@/lib/db/twins"

export interface EntityOption {
  value: string
  label: string
}

export interface EntityPickerProps {
  id: string
  value: string
  onChange: (value: string) => void
  options: EntityOption[]
  /** Trigger placeholder when nothing is selected. */
  placeholder?: string
  /** When set, prepends a "none" item that clears the value. */
  allowEmpty?: boolean
  /** Label for the "none" item (defaults to a translated "None"). */
  noneLabel?: string
  /** Offer a toggle to type a raw value / `{{ expression }}` instead. */
  allowExpression?: boolean
}

const NONE_VALUE = "__none__"

/** True when the value can't be represented as a pick (an expression or an
 * id the current options don't contain). Such values default to text mode. */
function looksLikeExpression(value: string): boolean {
  return value.includes("{{")
}

export function EntityPicker({
  id,
  value,
  onChange,
  options,
  placeholder,
  allowEmpty = false,
  noneLabel,
  allowExpression = false,
}: EntityPickerProps) {
  const t = useTranslations("workflows.forms.pickers")
  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState(() => allowExpression && looksLikeExpression(value))

  const selectedLabel = useMemo(() => {
    const hit = options.find((o) => o.value === value)
    return hit?.label ?? value
  }, [options, value])

  if (manual) {
    return (
      <div className="space-y-1.5">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={placeholder}
          placeholder="{{ $node['id'].out.field }}"
          className="font-mono"
        />
        {allowExpression ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-xs text-muted-foreground"
            onClick={() => setManual(false)}
            data-testid={`${id}-use-picker`}
          >
            <ListChecks className="mr-1 h-3 w-3" />
            {t("usePicker")}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <Combobox
        value={value || ""}
        onValueChange={(next: string | null) => {
          onChange(next === NONE_VALUE || next === null ? "" : next)
          setOpen(false)
        }}
        open={open}
        onOpenChange={setOpen}
      >
        <ComboboxInput
          id={id}
          placeholder={selectedLabel || placeholder}
          aria-label={placeholder}
        />
        <ComboboxContent>
          <ComboboxList>
            <ComboboxEmpty>{t("noResults")}</ComboboxEmpty>
            {allowEmpty ? (
              <ComboboxItem value={NONE_VALUE}>{noneLabel ?? t("none")}</ComboboxItem>
            ) : null}
            {options.map((o) => (
              <ComboboxItem key={o.value} value={o.value}>
                {o.label}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {allowExpression ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1 text-xs text-muted-foreground"
          onClick={() => setManual(true)}
          data-testid={`${id}-use-expression`}
        >
          <Code2 className="mr-1 h-3 w-3" />
          {t("useExpression")}
        </Button>
      ) : null}
    </div>
  )
}

// ── Entity-specific wrappers (Dexie-backed) ───────────────────────────────────

interface WrapperProps {
  id: string
  value: string
  onChange: (value: string) => void
  allowEmpty?: boolean
  allowExpression?: boolean
}

export function CharacterPicker({ allowExpression = true, ...props }: WrapperProps) {
  const t = useTranslations("workflows.forms.pickers")
  const rows = useLiveQuery(() => listCharacters(), [])
  const options = useMemo(() => rows?.map((c) => ({ value: c.id, label: c.name })) ?? [], [rows])
  return (
    <EntityPicker
      {...props}
      options={options}
      placeholder={t("character")}
      allowExpression={allowExpression}
    />
  )
}

export function TeamPicker({ allowExpression = true, ...props }: WrapperProps) {
  const t = useTranslations("workflows.forms.pickers")
  const rows = useLiveQuery(() => listTeams(), [])
  const options = useMemo(() => rows?.map((r) => ({ value: r.id, label: r.name })) ?? [], [rows])
  return (
    <EntityPicker
      {...props}
      options={options}
      placeholder={t("team")}
      allowExpression={allowExpression}
    />
  )
}

export function SkillPicker({
  allowEmpty = false,
  allowExpression = true,
  ...props
}: WrapperProps) {
  const t = useTranslations("workflows.forms.pickers")
  const rows = useLiveQuery(() => listSkills(), [])
  const options = useMemo(() => rows?.map((s) => ({ value: s.id, label: s.name })) ?? [], [rows])
  return (
    <EntityPicker
      {...props}
      options={options}
      placeholder={allowEmpty ? t("skillNew") : t("skill")}
      allowEmpty={allowEmpty}
      noneLabel={t("skillNoneItem")}
      allowExpression={allowExpression}
    />
  )
}

export function McpServerPicker({ allowExpression = true, ...props }: WrapperProps) {
  const t = useTranslations("workflows.forms.pickers")
  const rows = useLiveQuery(() => listMcpServers(), [])
  const options = useMemo(
    () => rows?.map((s) => ({ value: s.id, label: s.name ?? s.id })) ?? [],
    [rows]
  )
  return (
    <EntityPicker
      {...props}
      options={options}
      placeholder={t("mcpServer")}
      allowExpression={allowExpression}
    />
  )
}

export function PluginPicker({ allowExpression = true, ...props }: WrapperProps) {
  const t = useTranslations("workflows.forms.pickers")
  const rows = useLiveQuery(() => listPlugins(), [])
  const options = useMemo(
    () => rows?.map((p) => ({ value: p.id, label: p.name ?? p.id })) ?? [],
    [rows]
  )
  return (
    <EntityPicker
      {...props}
      options={options}
      placeholder={t("plugin")}
      allowExpression={allowExpression}
    />
  )
}

export function SubworkflowPicker({ allowExpression = true, ...props }: WrapperProps) {
  const t = useTranslations("workflows.forms.pickers")
  const rows = useLiveQuery(() => listWorkflows(), [])
  const options = useMemo(() => rows?.map((w) => ({ value: w.id, label: w.name })) ?? [], [rows])
  return (
    <EntityPicker
      {...props}
      options={options}
      placeholder={t("subworkflow")}
      allowExpression={allowExpression}
    />
  )
}

export function TwinPicker({ allowExpression = true, ...props }: WrapperProps) {
  const t = useTranslations("workflows.forms.pickers")
  const rows = useLiveQuery(() => listTwins(), [])
  const options = useMemo(() => rows?.map((tw) => ({ value: tw.id, label: tw.name })) ?? [], [rows])
  return (
    <EntityPicker
      {...props}
      options={options}
      placeholder={t("twin")}
      allowExpression={allowExpression}
    />
  )
}
