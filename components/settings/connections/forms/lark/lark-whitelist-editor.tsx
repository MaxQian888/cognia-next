"use client"

/**
 * Lark chat allow/blocklist editor (im-refactored-crayon).
 *
 * Persists `adapterInstances.chatAllowlist` + `chatBlocklist`. Read by
 * the inbound at-gate (`shouldRespondToMessage`) before any message is
 * forwarded to the bus:
 *   - non-empty allowlist → only chats in the list trigger a response
 *   - blocklist hit       → never respond
 *
 * Both lists hold raw Lark `chat_id` strings (`oc_...`). The operator
 * copies them from the Lark client URL or a previous audit row.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PlusIcon, XIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface LarkWhitelistEditorProps {
  adapterId: string
}

function ChatList({
  label,
  testId,
  items,
  onAdd,
  onRemove,
  helpText,
  placeholder,
  emptyLabel,
  removeAriaTemplate,
}: {
  label: string
  testId: string
  items: string[]
  onAdd: (id: string) => void
  onRemove: (id: string) => void
  helpText: string
  placeholder: string
  emptyLabel: string
  removeAriaTemplate: string
}) {
  const [draft, setDraft] = useState("")
  const handleAdd = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    if (items.includes(trimmed)) {
      setDraft("")
      return
    }
    onAdd(trimmed)
    setDraft("")
  }
  return (
    <div className="space-y-2" data-testid={testId}>
      <Label className="text-xs">{label}</Label>
      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              handleAdd()
            }
          }}
          data-testid={`${testId}-input`}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleAdd}
          data-testid={`${testId}-add`}
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{helpText}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{emptyLabel}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1"
              data-testid={`${testId}-item-${id}`}
            >
              <span className="font-mono text-xs">{id}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onRemove(id)}
                aria-label={removeAriaTemplate.replace("{id}", id)}
                className="ml-1 size-5 rounded-sm hover:bg-muted"
                data-testid={`${testId}-remove-${id}`}
              >
                <XIcon className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

export function LarkWhitelistEditor({ adapterId }: LarkWhitelistEditorProps) {
  const t = useTranslations("settings.connections.lark.whitelist")

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const allowlist = row?.chatAllowlist ?? []
  const blocklist = row?.chatBlocklist ?? []

  const setAllowlist = async (next: string[]) => {
    await updateAdapterInstance(adapterId, {
      chatAllowlist: next.length > 0 ? next : undefined,
    })
  }
  const setBlocklist = async (next: string[]) => {
    await updateAdapterInstance(adapterId, {
      chatBlocklist: next.length > 0 ? next : undefined,
    })
  }

  return (
    <Card data-testid="lark-whitelist-editor">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChatList
          label={t("allowlistLabel")}
          testId="lark-allowlist"
          items={allowlist}
          onAdd={(id) => void setAllowlist([...allowlist, id])}
          onRemove={(id) => void setAllowlist(allowlist.filter((x) => x !== id))}
          helpText={t("helpText")}
          placeholder={t("addChatIdPlaceholder")}
          emptyLabel={t("allowlistEmpty")}
          removeAriaTemplate={t.has("removeAria") ? t("removeAria", { id: "{id}" }) : "Remove {id}"}
        />
        <ChatList
          label={t("blocklistLabel")}
          testId="lark-blocklist"
          items={blocklist}
          onAdd={(id) => void setBlocklist([...blocklist, id])}
          onRemove={(id) => void setBlocklist(blocklist.filter((x) => x !== id))}
          helpText={t("helpText")}
          placeholder={t("addChatIdPlaceholder")}
          emptyLabel={t("blocklistEmpty")}
          removeAriaTemplate={t.has("removeAria") ? t("removeAria", { id: "{id}" }) : "Remove {id}"}
        />
      </CardContent>
    </Card>
  )
}
