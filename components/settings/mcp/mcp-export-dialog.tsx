"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { CopyIcon, DownloadIcon, ShareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { downloadFile } from "@/lib/files/download"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { MCP_AGENT_ADAPTERS } from "@/lib/claude/agents"
import {
  buildMcpInstallCommand,
  buildMcpTransferJson,
  INSTALL_COMMAND_TARGETS,
} from "@/lib/mcp/config-transfer"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import type { AgentId } from "@cognia/agent-config-types"

type ExportFormat = "json" | "command"

/** Sentinel for "the portable `{"mcpServers": …}` block every agent reads". */
const CANONICAL = "__canonical__"

/**
 * The reverse of {@link McpTransferDialog}: turn configured servers back into
 * the command or JSON another tool accepts.
 *
 * This is how a working server leaves Cognia — onto a machine we do not run
 * on, into a teammate's chat, into a repo's `.mcp.json`. Both directions share
 * one parser/serializer pair, so anything this dialog emits is something the
 * paste box can read back.
 *
 * Credential values never appear: a `secretRef` is rendered as its locator, so
 * the exported text is safe to paste into a shared channel.
 */
export function McpExportDialog() {
  const t = useTranslations("mcp.export")
  const target = useMcpPanelStore((s) => s.exportTarget)
  const closeExport = useMcpPanelStore((s) => s.closeExport)
  const [format, setFormat] = useState<ExportFormat>("json")
  const [agent, setAgent] = useState<string>(CANONICAL)

  const servers = useLiveQuery(() => listMcpServers(), [])
  const selected = useMemo(() => {
    if (!target || !servers) return []
    const wanted = new Set(target.serverIds)
    const rows = wanted.size === 0 ? servers : servers.filter((row) => wanted.has(row.id))
    return rows.map((row) => ({
      name: row.name,
      transport: row.transport,
      config: row.config as Record<string, unknown>,
    }))
  }, [target, servers])

  const agentId = agent === CANONICAL ? undefined : (agent as AgentId)

  const output = useMemo(() => {
    if (selected.length === 0) return ""
    if (format === "json") return buildMcpTransferJson(selected, agentId)
    return selected.map((server) => buildMcpInstallCommand(server, agentId)).join("\n")
  }, [selected, format, agentId])

  const copy = async () => {
    try {
      await writeClipboardText(output)
      toast.success(t("copied"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const download = () => {
    const extension = format === "json" ? "json" : "sh"
    downloadFile(
      `cognia-mcp-servers.${extension}`,
      output,
      format === "json" ? "application/json" : "text/plain"
    )
    toast.success(t("downloaded"))
  }

  const commandAgents = MCP_AGENT_ADAPTERS.filter((adapter) => INSTALL_COMMAND_TARGETS[adapter.id])
  const jsonAgents = MCP_AGENT_ADAPTERS.filter((adapter) => adapter.writable)
  const agentOptions = format === "command" ? commandAgents : jsonAgents

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && closeExport()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShareIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("subtitle", { count: selected.length })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("format")}
              </Label>
              <ToggleGroup
                type="single"
                value={format}
                onValueChange={(value) => value && setFormat(value as ExportFormat)}
                variant="outline"
                size="sm"
              >
                <ToggleGroupItem value="json" className="text-xs">
                  {t("formatJson")}
                </ToggleGroupItem>
                <ToggleGroupItem value="command" className="text-xs">
                  {t("formatCommand")}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="min-w-44 flex-1 space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("target")}
              </Label>
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger size="sm" className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CANONICAL}>{t("targetCanonical")}</SelectItem>
                  {agentOptions.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>
                      {adapter.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Textarea
            value={output}
            readOnly
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
            aria-label={t("title")}
            data-testid="mcp-export-output"
          />
          <p className="text-[10px] text-muted-foreground">{t("secretNote")}</p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={closeExport}>
            {t("close")}
          </Button>
          <Button variant="outline" size="sm" onClick={download} disabled={!output}>
            <DownloadIcon className="size-3.5" />
            {t("download")}
          </Button>
          <Button size="sm" onClick={() => void copy()} disabled={!output}>
            <CopyIcon className="size-3.5" />
            {t("copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
