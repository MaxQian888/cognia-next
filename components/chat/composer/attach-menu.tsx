"use client"

// The composer's `+` — everything you can bring to a turn, behind one trigger.
//
// Three groups, because the entries answer three different questions:
//
//   ADD        what goes INTO this message (files, a folder, a screenshot, a
//              cloud document, a record from the workspace)
//   THIS TURN  how the turn RUNS (plan mode, a goal, skills, the recorder)
//   EXTEND     what else can be reached (slash commands, external services)
//
// Two of those groups end in a submenu, and the submenus DRILL DOWN inside the
// same popover rather than flying out of it. A flyout would mean a second
// Radix layer over a panel that already composes with the folder-confirm
// dialog and with plugin UI that owns its own overlays; the drill-down keeps
// one layer and one dismiss path, and it is the only shape that works
// unchanged on touch.
//
// The turn-capability chips (web search, Skills) are injected by the composer
// as `capabilities` and land in THIS TURN; the mobile composer injects the same
// node into `ComposerPlusMenu`, so placement stays consistent across platforms.
//
// A Popover, not a DropdownMenu, so the panel composes with the nested dialogs
// the attach branches raise (the large-folder confirm) without fighting Radix's
// DismissableLayer stack.
//
// Files and screenshots go through the inline attachment model; a folder goes
// through the native directory dialog into `referencedPaths` (reference model —
// the agent reads on demand). Large folders prompt a confirm first (warn +
// confirm, never silently pull a huge tree). Off desktop there is no real
// filesystem path to reference and no screen to capture, so those branches drop
// out.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AtSignIcon,
  CameraIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CloudIcon,
  FilePlusIcon,
  FolderPlusIcon,
  LightbulbIcon,
  Loader2Icon,
  PlugIcon,
  PlusIcon,
  ScanTextIcon,
  SlashIcon,
  TargetIcon,
} from "lucide-react"
import { useChatStore, useComposerPermissionMode } from "@/stores/chat"
import { usePlatform } from "@/hooks/use-platform"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { captureScreenshot } from "@/lib/ui/screenshot"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { loggers } from "@cognia/logging"
import {
  pickFolder,
  summarizeFolder,
  folderReference,
  type FolderSummary,
} from "@/lib/chat/folder-context"
import { cn } from "@/lib/utils"
import { listAvailableDocsProviders } from "@/lib/docs-providers/registry"
import { listEntityMentionSources } from "@/lib/chat/mentions/entity-sources"
import { listExternalCapabilities } from "@/lib/external-services/catalog"
import { openRecorder } from "@/stores/skills/recorder-store"
import { useRecorderAvailable } from "@/hooks/skills/use-skill-recorder"
import { useComposerSessionId } from "./composer-session-context"

export interface ComposerAttachMenuProps {
  disabled?: boolean
  /** Opens the composer's hidden `<input type="file">`. */
  onPickFiles: () => void
  /** Turn capabilities colocated under the same `+` trigger. */
  capabilities?: React.ReactNode
  /** Capture the currently focused desktop app as image + accessibility context. */
  onSmartSnapshot?: () => void
  smartSnapshotPending?: boolean
  /**
   * Type something into the composer on the user's behalf.
   *
   * Every namespace entry below routes through this rather than owning a picker
   * of its own: `@lark:` and `@issue:` already open their panels from the
   * composer's own trigger detection, so the menu's job is to put the user in
   * front of that panel, not to reimplement it. Absent ⇒ those entries hide,
   * because an entry that cannot reach its panel is worse than no entry.
   */
  onInsert?: (text: string) => void
  /**
   * Open the external-services settings. The menu only ever COUNTS what this
   * turn can reach and sends the user where it can be changed — the
   * capabilities themselves are agent-facing tools with no per-turn action to
   * offer. Absent ⇒ the row hides.
   */
  onOpenExternalServices?: () => void
  className?: string
}

/** Which panel the popover is showing. The submenus drill down in place. */
type MenuView = "root" | "docs" | "records"

export function ComposerAttachMenu({
  disabled,
  onPickFiles,
  capabilities,
  onSmartSnapshot,
  smartSnapshotPending = false,
  onInsert,
  onOpenExternalServices,
  className,
}: ComposerAttachMenuProps) {
  const t = useTranslations("chat.composer")
  const tEntities = useTranslations("chat.composer.popover.entityKinds")
  const tDocs = useTranslations("docsProviders")
  const isDesktop = usePlatform() === "tauri"
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const composerSessionId = useComposerSessionId()
  // THIS composer's conversation, matching the `setPermissionMode` write below.
  // The store-level `permissionMode` is a live mirror of the ACTIVE session, so
  // in a background pane it would light the row for someone else's plan mode
  // and then toggle away from a state this conversation was never in.
  const permissionMode = useComposerPermissionMode(composerSessionId)
  const attachments = usePromptInputAttachments()
  const recorderAvailable = useRecorderAvailable()
  const [pending, setPending] = useState<FolderSummary | null>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<MenuView>("root")

  // Read at render, not at module load: all three registries are populated by
  // initializers and by plugins, so a snapshot taken once would leave a menu
  // that never grows a provider the user just connected.
  // HOST-filtered, not the raw registry: both built-in providers are
  // `hosts: ["tauri"]`, so in a plain browser the raw list would offer a
  // submenu whose every entry opens a panel that can only explain that this
  // host cannot run it. Typing `@lark:` still reaches that explanation for
  // anyone who knows the syntax — the menu is for what you can do HERE.
  const docsProviders = listAvailableDocsProviders()
  const entitySources = listEntityMentionSources()
  const chatServices = listExternalCapabilities({ surface: "chat" })

  /** Close, and put the panel back on the root for the next open. */
  const closeMenu = () => {
    setOpen(false)
    setView("root")
  }

  const insertAndClose = (text: string) => {
    closeMenu()
    onInsert?.(text)
  }

  const triggerClassName = cn("size-9 text-muted-foreground hover:text-foreground", className)

  const add = (summary: FolderSummary) =>
    addReferencedPath(folderReference(summary), composerSessionId)

  const onPickFolder = async () => {
    try {
      const dir = await pickFolder()
      if (!dir) return
      const summary = await summarizeFolder(dir)
      if (summary.needsConfirm) {
        setPending(summary)
        return
      }
      add(summary)
    } catch (err) {
      loggers.chat.error("folder pick failed", err)
    }
  }

  // `getDisplayMedia` needs a real screen, so this branch is desktop-only —
  // asking a browser user to share their screen for a chat attachment is noise.
  const onScreenshot = async () => {
    try {
      const file = await captureScreenshot()
      if (!file) return
      attachments.add([file])
    } catch (err) {
      loggers.chat.warn("screenshot capture failed", {
        err: err instanceof Error ? err.message : String(err),
      })
      toast.error(err instanceof Error ? err.message : t("screenshot.captureFailed"))
    }
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setView("root")
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                aria-label={t("attachMenu.trigger")}
                className={triggerClassName}
                data-testid="composer-attach-menu"
                disabled={disabled}
                size="icon"
                type="button"
                variant="ghost"
              >
                <PlusIcon className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("attachMenu.trigger")}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" className="w-64 p-1">
          {view === "docs" ? (
            <SubPanel title={t("attachMenu.cloudDocs")} onBack={() => setView("root")}>
              {docsProviders.map((provider) => (
                <PanelItem
                  key={provider.id}
                  icon={<CloudIcon className="size-4" />}
                  // Keyed by provider id so a newly registered provider needs
                  // one message, not a branch here. `lint:i18n` cannot check a
                  // template key, so `docs-providers.i18n.test.ts` pins the
                  // catalogue against the registry instead.
                  label={tDocs(`name.${provider.id}` as "name.lark")}
                  onSelect={() => insertAndClose(`@${provider.mentionPrefix}`)}
                />
              ))}
            </SubPanel>
          ) : view === "records" ? (
            <SubPanel title={t("attachMenu.records")} onBack={() => setView("root")}>
              {entitySources.map((source) => (
                <PanelItem
                  key={source.entityKind}
                  icon={<AtSignIcon className="size-4" />}
                  label={tEntities(source.entityKind as "issue")}
                  onSelect={() => insertAndClose(`@${source.prefix}`)}
                />
              ))}
            </SubPanel>
          ) : (
            <>
              <PanelLabel>{t("attachMenu.attachGroup")}</PanelLabel>
              <PanelItem
                icon={<FilePlusIcon className="size-4" />}
                label={t("attachMenu.file")}
                onSelect={() => {
                  closeMenu()
                  onPickFiles()
                }}
              />
              {isDesktop && (
                <>
                  <PanelItem
                    icon={<FolderPlusIcon className="size-4" />}
                    label={t("attachMenu.folder")}
                    onSelect={() => {
                      closeMenu()
                      void onPickFolder()
                    }}
                  />
                  <PanelItem
                    icon={<CameraIcon className="size-4" />}
                    label={t("screenshot.captureTooltip")}
                    onSelect={() => {
                      closeMenu()
                      void onScreenshot()
                    }}
                  />
                  {onSmartSnapshot ? (
                    <PanelItem
                      icon={
                        smartSnapshotPending ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <ScanTextIcon className="size-4" />
                        )
                      }
                      label={t("smartSnapshot.captureTooltip")}
                      onSelect={() => {
                        closeMenu()
                        onSmartSnapshot()
                      }}
                      disabled={smartSnapshotPending}
                    />
                  ) : null}
                </>
              )}
              {/* Both namespaces are reached by typing, so both entries just
                  type. Hidden without a way to type, and without a registered
                  provider / source — an empty submenu teaches nothing. */}
              {onInsert && docsProviders.length > 0 ? (
                <PanelItem
                  icon={<CloudIcon className="size-4" />}
                  label={t("attachMenu.cloudDocs")}
                  onSelect={() => setView("docs")}
                  chevron
                />
              ) : null}
              {onInsert && entitySources.length > 0 ? (
                <PanelItem
                  icon={<AtSignIcon className="size-4" />}
                  label={t("attachMenu.records")}
                  onSelect={() => setView("records")}
                  chevron
                />
              ) : null}

              <PanelLabel className="mt-1 border-t border-border pt-2">
                {t("attachMenu.turnGroup")}
              </PanelLabel>
              {/* Plan mode already has a chip on the status row; this is a
                  second ENTRANCE to the same session state, not a second copy
                  of it — the chip stays the place you read it at a glance. */}
              <PanelItem
                icon={<LightbulbIcon className="size-4" />}
                label={t("attachMenu.planMode")}
                active={permissionMode === "plan"}
                onSelect={() => {
                  setPermissionMode(
                    permissionMode === "plan" ? "default" : "plan",
                    composerSessionId
                  )
                  closeMenu()
                }}
              />
              {onInsert ? (
                <PanelItem
                  icon={<TargetIcon className="size-4" />}
                  label={t("attachMenu.goal")}
                  onSelect={() => insertAndClose("/goal ")}
                />
              ) : null}
              {/* Desktop-only and plugin-gated: `useRecorderAvailable` is false
                  wherever the recorder plugin is not running, and an entry that
                  opens a sheet nothing can fill is worse than no entry. */}
              {recorderAvailable ? (
                <PanelItem
                  icon={<CircleDotIcon className="size-4" />}
                  label={t("attachMenu.recordSkill")}
                  onSelect={() => {
                    closeMenu()
                    openRecorder("toolbar")
                  }}
                />
              ) : null}
              {capabilities ? (
                <div className="flex flex-wrap items-center gap-2 px-2 py-1">{capabilities}</div>
              ) : null}

              <PanelLabel className="mt-1 border-t border-border pt-2">
                {t("attachMenu.extendGroup")}
              </PanelLabel>
              {onInsert ? (
                <PanelItem
                  icon={<SlashIcon className="size-4" />}
                  label={t("attachMenu.slashCommands")}
                  onSelect={() => insertAndClose("/")}
                />
              ) : null}
              {/* One row, not a submenu: a service capability is a TOOL the
                  agent may call, so there is no per-turn action to put behind a
                  chevron — a list of them would be a list of dead rows. The
                  count is the useful part (what this turn can reach), and the
                  row goes where you can change it. */}
              {onOpenExternalServices && chatServices.length > 0 ? (
                <PanelItem
                  icon={<PlugIcon className="size-4" />}
                  label={t("attachMenu.externalServices", { count: chatServices.length })}
                  onSelect={() => {
                    closeMenu()
                    onOpenExternalServices()
                  }}
                />
              ) : null}
            </>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("folder.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("folder.confirmBody", {
                count: pending?.fileCount ?? 0,
                name: pending?.relative ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPending(null)}>
              {t("folder.confirmCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) add(pending)
                setPending(null)
              }}
            >
              {t("folder.confirmAdd")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function PanelLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground",
        className
      )}
    >
      {children}
    </p>
  )
}

/**
 * A drill-down panel: one back row, then the submenu's own items.
 *
 * The back row is a real button rather than a header with an icon in it, so the
 * only way out is also the largest target — the same reason the root rows are
 * full-width buttons.
 */
function SubPanel({
  title,
  onBack,
  children,
}: {
  title: string
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
      >
        <ChevronLeftIcon className="size-4 text-muted-foreground" />
        <span className="flex-1 font-medium">{title}</span>
      </button>
      <div className="mt-1 border-t border-border pt-1">{children}</div>
    </>
  )
}

function PanelItem({
  icon,
  label,
  onSelect,
  active,
  disabled,
  chevron,
}: {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  active?: boolean
  disabled?: boolean
  /** Renders the "opens a submenu" affordance. */
  chevron?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        active && "text-foreground"
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {active && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
      {chevron && <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />}
    </button>
  )
}
