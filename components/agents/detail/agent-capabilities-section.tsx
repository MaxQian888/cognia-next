"use client"

/**
 * What an agent can reach (ADR-0220), read back in words for the side column
 * of its profile: the skills, MCP servers and knowledge bases it carries (ids
 * resolved to names, missing ones marked), which tools it may and may not
 * use, which built-in powers it overrides, and what its memory may do.
 * Editing happens in the edit mode.
 */

import { useTranslations } from "next-intl"
import type { Character } from "@cognia/agent-config-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { usePluginSkillsById } from "@/hooks/skills/use-plugin-skills"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import { cn } from "@/lib/utils"
import { AgentFactRow, AgentSection } from "./agent-section"

export interface AgentCapabilitiesSectionProps {
  agent: Character
  catalogs: AgentCatalogs
  /** Offer "Edit"; absent for an agent that cannot be edited in place. */
  onEdit?: () => void
}

interface Named {
  id: string
  name: string
  missing: boolean
}

function resolve(
  ids: readonly string[] | undefined,
  byId: (id: string) => string | undefined
): Named[] {
  return (ids ?? []).map((id) => {
    const name = byId(id)
    return { id, name: name ?? id, missing: name === undefined }
  })
}

const POWERS = [
  ["computerUse", "enableComputerUse"],
  ["browserTools", "enableBrowserTools"],
  ["ocr", "enableOcr"],
  ["builtInSkills", "enableBuiltInSkills"],
  ["sandbox", "sandboxEnabled"],
] as const

export function AgentCapabilitiesSection({
  agent,
  catalogs,
  onEdit,
}: AgentCapabilitiesSectionProps) {
  const t = useTranslations("agentsConsole.capabilities")
  const pluginSkills = usePluginSkillsById()
  const skills = [
    ...resolve(agent.skillIds, (id) => catalogs.skills.find((s) => s.id === id)?.name),
    ...resolve(agent.pluginSkillIds, (id) => pluginSkills.get(id)?.name),
  ]
  const mcp = resolve(
    agent.mcpServerIds,
    (id) => catalogs.mcpServers.find((m) => m.id === id)?.name
  )
  const knowledge = resolve(
    agent.knowledgeBaseIds,
    (id) => catalogs.knowledgeBases.find((kb) => kb.id === id)?.name
  )
  const memory = agent.memoryPolicy
  // Only the powers this agent sets for itself; the rest follow the app, and
  // five rows of "follows the app" said nothing.
  const overridden = POWERS.filter(([, field]) => agent[field] !== undefined)

  return (
    <AgentSection
      id="capabilities"
      title={t("title")}
      action={
        onEdit ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onEdit}
            data-testid="agent-capabilities-edit"
          >
            {t("edit")}
          </Button>
        ) : undefined
      }
    >
      <dl className="-my-1.5" data-testid="agent-capabilities">
        <AgentFactRow label={t("skills")} wrap>
          <Names items={skills} empty={t("none")} missing={t("missing")} />
        </AgentFactRow>
        <AgentFactRow label={t("mcpServers")} wrap>
          <Names
            items={mcp}
            empty={agent.mcpServerIds === undefined ? t("allEnabledServers") : t("none")}
            missing={t("missing")}
          />
        </AgentFactRow>
        <AgentFactRow label={t("knowledgeBases")} wrap>
          <Names items={knowledge} empty={t("none")} missing={t("missing")} />
        </AgentFactRow>
        <AgentFactRow label={t("allowed")} mono={Boolean(agent.allowedTools?.length)} wrap>
          {agent.allowedTools && agent.allowedTools.length > 0
            ? agent.allowedTools.join(", ")
            : t("allowedAll")}
        </AgentFactRow>
        <AgentFactRow label={t("denied")} mono={Boolean(agent.disallowedTools?.length)} wrap>
          {agent.disallowedTools && agent.disallowedTools.length > 0
            ? agent.disallowedTools.join(", ")
            : t("deniedNone")}
        </AgentFactRow>
        <AgentFactRow label={t("powers")} wrap>
          {overridden.length === 0 ? (
            <span className="text-muted-foreground">{t("inherit")}</span>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {overridden.map(([key, field]) => (
                <Badge
                  key={key}
                  variant={agent[field] ? "secondary" : "outline"}
                  className={cn(
                    "px-1.5 py-0.5 text-[11px] font-normal",
                    !agent[field] && "line-through"
                  )}
                  data-testid={`agent-power-${key}`}
                >
                  {t(`power.${key}`)}
                </Badge>
              ))}
            </span>
          )}
        </AgentFactRow>
        <AgentFactRow label={t("memory")} wrap>
          {memory ? (
            <span className="block space-y-1">
              <span className="flex flex-wrap gap-1.5">
                {(["recall", "create", "update", "forget"] as const).map((op) => (
                  <Badge
                    key={op}
                    variant={memory.operations[op] ? "secondary" : "outline"}
                    className={cn(
                      "px-1.5 py-0.5 text-[11px] font-normal",
                      !memory.operations[op] && "line-through"
                    )}
                  >
                    {t(`memoryOp.${op}`)}
                  </Badge>
                ))}
              </span>
              <span className="block text-muted-foreground">
                {t("memorySummary", {
                  read: memory.readableScopes.join(", ") || t("none"),
                  write: memory.writableScopes.join(", ") || t("none"),
                  autoLearn: memory.autoLearn ? t("on") : t("off"),
                })}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t("memoryDefault")}</span>
          )}
        </AgentFactRow>
      </dl>
    </AgentSection>
  )
}

function Names({ items, empty, missing }: { items: Named[]; empty: string; missing: string }) {
  if (items.length === 0) return <span className="text-muted-foreground">{empty}</span>
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge
          key={item.id}
          variant="outline"
          className={cn(
            "px-1.5 py-0.5 text-[11px] font-normal",
            item.missing && "border-destructive/40 text-destructive"
          )}
          title={item.missing ? missing : undefined}
        >
          {item.name}
        </Badge>
      ))}
    </span>
  )
}
