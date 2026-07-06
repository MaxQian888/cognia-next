"use client"

/**
 * Mobile Slash Commands page (ADR-0056, decision D6 — desktop-bound section,
 * read-only on mobile). Custom slash commands are authored as
 * `.claude/commands/*.md` files via Tauri FS (desktop-only write), so the
 * standalone (BYOK) phone has no write path. This `<PairedOnly>` read view
 * lists the commands the paired desktop can run:
 *   - Built-in commands from the static `BUILTIN_SLASH_COMMANDS` registry
 *     (importable client-side, no runtime needed).
 *   - Plugin commands registered through the unified slash-command registry.
 *
 * Creating / editing / deleting custom commands stays "manage on desktop"
 * (decisions D6 + the "no new companion RPC" rule).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { MonitorSmartphoneIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { BUILTIN_SLASH_COMMANDS } from "@/lib/slash-commands/builtin"
import { listSlashCommands } from "@/lib/slash-commands/registry"

function SlashCommandsBody() {
  const t = useTranslations("mobile.slashCommands")

  const builtin = useMemo(
    () => [...BUILTIN_SLASH_COMMANDS].sort((a, b) => a.name.localeCompare(b.name)),
    []
  )
  const plugins = useMemo(
    () =>
      listSlashCommands()
        .filter((c) => c.source === "plugin")
        .sort((a, b) => a.name.localeCompare(b.name)),
    []
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="slash-commands-intro">
        {t("intro")}
      </p>

      <MeSection
        title={t("builtin.title")}
        description={t("builtin.description")}
        testid="me-section-slash-commands-builtin"
      >
        {builtin.map((c) => (
          <Item key={c.name} size="sm" className="px-0" data-testid={`slash-command-row-${c.name}`}>
            <ItemContent>
              <ItemTitle className="text-sm">
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/{c.name}</code>
              </ItemTitle>
              {c.description ? (
                <ItemDescription className="line-clamp-2">{c.description}</ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
        ))}
      </MeSection>

      <MeSection
        title={t("plugin.title")}
        description={t("plugin.description")}
        testid="me-section-slash-commands-plugin"
      >
        {plugins.length === 0 ? (
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemDescription>{t("plugin.empty")}</ItemDescription>
            </ItemContent>
          </Item>
        ) : (
          plugins.map((c) => (
            <Item key={c.id} size="sm" className="px-0" data-testid={`slash-plugin-row-${c.id}`}>
              <ItemContent>
                <ItemTitle className="text-sm">
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/{c.name}</code>
                </ItemTitle>
                {c.description ? (
                  <ItemDescription className="line-clamp-2">{c.description}</ItemDescription>
                ) : null}
              </ItemContent>
            </Item>
          ))
        )}
      </MeSection>

      <div
        className="flex items-start gap-3 rounded-xl border bg-card px-3 py-3 text-xs text-muted-foreground"
        data-testid="slash-commands-manage-note"
      >
        <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t("manageOnDesktop")}</p>
      </div>
    </div>
  )
}

export default function MobileSlashCommandsPage() {
  const t = useTranslations("mobile.slashCommands")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-slash-commands-page">
      <PairedOnly>
        <SlashCommandsBody />
      </PairedOnly>
    </SubPageShell>
  )
}
