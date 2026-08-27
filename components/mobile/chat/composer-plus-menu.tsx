"use client"

/**
 * Mobile chat composer `+` menu.
 *
 * Same three groups as the desktop `ComposerAttachMenu` — ADD (what goes into
 * this message), THIS TURN (how the turn runs), EXTEND (what else can be
 * reached) — but not the same surface, because a phone is not a small desktop:
 *
 *   - It is a bottom DRAWER, not a popover anchored above the composer. On a
 *     phone the composer is usually sitting on top of the software keyboard,
 *     which leaves a couple of hundred pixels above it; a popover with three
 *     groups in it would be squeezed or flipped. A drawer anchors to the
 *     viewport, takes focus (so the keyboard steps aside on its own), gets
 *     swipe-to-dismiss for free, and — via `useBackDismiss` — closes on the
 *     Android hardware back button instead of navigating away.
 *   - The media pickers stay a TILE GRID (the WeChat/Telegram idiom: big,
 *     thumb-sized, glanceable) while everything else is a full-width row. Two
 *     affordances, because the two halves are different kinds of action: one
 *     produces an attachment, the other changes what the turn can do.
 *   - Every row clears the 44pt touch floor (`touch-target`), and the sheet
 *     pads itself past the home indicator.
 *
 * What is NOT here, and why: folder references, screen capture and the smart
 * snapshot need a real filesystem/desktop screen, and the skill recorder is
 * native desktop automation. Cloud documents are not special-cased at all —
 * `listAvailableDocsProviders()` filters by host, so the built-in `hosts:
 * ["tauri"]` providers drop out on their own and a mobile-capable provider
 * would appear here the day one is registered.
 *
 * Attachment branches (unchanged):
 *
 *   - Camera   → `lib/capacitor/camera.ts:pickPhoto({ source: "camera" })`
 *   - Album    → `lib/capacitor/camera.ts:pickMultiplePhotos`
 *   - File     → web file input (Capacitor filesystem v7 lacks a unified
 *                picker; `<input type="file">` works on both Capacitor and
 *                browsers)
 *   - Voice    → `capacitor-voice-recorder` (loaded lazily so the web
 *                bundle skips the native module)
 *
 * The menu is purely an action launcher — the chosen attachment is
 * forwarded to `onAttach(payload)` so the chat-room component can persist
 * + enqueue an outbound `connector_send` job as appropriate.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AtSignIcon,
  CameraIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudIcon,
  FileIcon,
  ImageIcon,
  LightbulbIcon,
  MicIcon,
  PlugIcon,
  PlusIcon,
  SlashIcon,
  TargetIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { useChatStore, useComposerPermissionMode } from "@/stores/chat"
import { useComposerSessionId } from "@/components/chat/composer/composer-session-context"
import { listAvailableDocsProviders } from "@/lib/docs-providers/registry"
import { listEntityMentionSources } from "@/lib/chat/mentions/entity-sources"
import { listExternalCapabilities } from "@/lib/external-services/catalog"
import { pickMultiplePhotos, pickPhoto } from "@/lib/capacitor/camera"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { showToast } from "@/lib/capacitor/toast"
import { makeDefaultLoader, withPlugin } from "@/lib/capacitor/_shared"
import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"
import {
  packPhotoAsSendContent,
  packUriAsImageBlock,
  packFileAsImageBlock,
  type ComposerAttachment,
} from "./composer-attachment"
import { cn } from "@/lib/utils"

export interface ComposerPlusMenuProps {
  /**
   * Receives the result of whichever option the user picked. Should NOT
   * persist the message — it's the caller's job to fold the attachment
   * into a draft + outbound queue write.
   */
  onAttach: (attachment: ComposerAttachment) => void
  /**
   * Optional. When provided, the camera/album/file branches additionally
   * pack their result as a {@link SendContent} block array and forward it
   * to this callback so the chat composer can ship the attachment through
   * the normal send pipeline (`claude_send` → SDK image block).
   *
   * Image picks become `{ type: "image", source: { type: "base64", data,
   * media_type } }` blocks; non-image files fall back through `onAttach`
   * since the SDK's send shape doesn't carry generic file blocks (yet).
   * Voice is intentionally left to `onAttach` only — outbound queue is
   * the right path for voice payloads.
   */
  onSend?: (content: SendContent) => Promise<void> | void
  /** Triggered with the raw error code on failure paths (permission, etc.). */
  onError?: (code: string, message: string) => void
  /**
   * Hide the voice-recording branch. The main chat composer sets this to
   * false because voice input there is the transcription bridge (speech →
   * text) — an audio *attachment* has no send path to the model. Connector
   * chat surfaces keep the default (true) since `connector_send` can carry
   * media payloads.
   */
  showVoice?: boolean
  /** `accept` for the file-branch input; defaults to any file. */
  fileAccept?: string
  /** Turn capabilities colocated under the same `+` trigger. */
  capabilities?: React.ReactNode
  /**
   * Type something into the composer on the user's behalf.
   *
   * Same contract as the desktop menu: `@lark:`, `@issue:`, `/goal ` and `/`
   * already open their own panels from the composer's trigger detection (which
   * runs on mobile too — `ComposerPopover` is only overridden for `@file` /
   * `@agent`), so the menu puts the user in front of that panel instead of
   * reimplementing it. Absent ⇒ those entries hide.
   */
  onInsert?: (text: string) => void
  /**
   * Open the external-services settings. The menu only COUNTS what this turn
   * can reach — a service capability is an agent-facing tool with no per-turn
   * action to offer — and sends the user where it can be changed.
   */
  onOpenExternalServices?: () => void
  className?: string
}

/** Which panel the sheet is showing. One level of drill-down, in place. */
type MenuView = "root" | "docs" | "records"

interface VoiceRecorderShape {
  requestAudioRecordingPermission(): Promise<{ value: boolean }>
  hasAudioRecordingPermission(): Promise<{ value: boolean }>
  startRecording(): Promise<{ value: boolean }>
  stopRecording(): Promise<{
    value: { recordDataBase64: string; mimeType: string; msDuration: number }
  }>
}

const voiceLoader = makeDefaultLoader<VoiceRecorderShape>(
  "capacitor-voice-recorder",
  "VoiceRecorder"
)

export function ComposerPlusMenu({
  onAttach,
  onSend,
  onError,
  showVoice = true,
  fileAccept,
  capabilities,
  onInsert,
  onOpenExternalServices,
  className,
}: ComposerPlusMenuProps) {
  const t = useTranslations("mobile.composerPlus")
  const tMenu = useTranslations("chat.composer.attachMenu")
  const tEntities = useTranslations("chat.composer.popover.entityKinds")
  const tDocs = useTranslations("docsProviders")
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<MenuView>("root")
  const [recording, setRecording] = useState(false)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const composerSessionId = useComposerSessionId()
  // THIS composer's conversation, matching the `setPermissionMode` write below.
  // The store-level `permissionMode` mirrors the ACTIVE session, which is not
  // necessarily the one this sheet was opened over.
  const permissionMode = useComposerPermissionMode(composerSessionId)

  // Read at render, not at module load: all three registries are populated by
  // initializers and by plugins, so a snapshot taken once would leave a sheet
  // that never grows a provider the user just connected. `listAvailable…` is
  // the host-filtered read — see the header note on cloud documents.
  const docsProviders = listAvailableDocsProviders()
  const entitySources = listEntityMentionSources()
  const chatServices = listExternalCapabilities({ surface: "chat" })

  useBackDismiss(open, () => closeMenu())

  /** Close, and put the sheet back on the root for the next open. */
  function closeMenu() {
    setOpen(false)
    setView("root")
  }

  const insertAndClose = (text: string) => {
    closeMenu()
    onInsert?.(text)
  }

  const onCamera = async () => {
    closeMenu()
    void selectionFeedback()
    const result = await pickPhoto({ source: "camera", resultType: "base64" })
    if (result.kind === "captured") {
      const mime = `image/${result.format}`
      onAttach({
        kind: "photo",
        base64: result.base64,
        uri: result.uri,
        mime,
      })
      if (onSend && result.base64) {
        await onSend(packPhotoAsSendContent(result.base64, mime))
      }
      return
    }
    if (result.kind === "permission_denied") {
      onError?.("permission", t("permissionDeniedCamera"))
      void showToast({ text: t("permissionDeniedCamera") })
      return
    }
    if (result.kind === "cancelled") return
    if (result.kind === "unsupported") {
      onError?.("unsupported", t("unsupported"))
      return
    }
    onError?.("error", result.message)
  }

  const onAlbum = async () => {
    closeMenu()
    void selectionFeedback()
    const result = await pickMultiplePhotos({ limit: 9 })
    if (result.kind === "picked") {
      const items = result.photos.map((p) => ({ uri: p.uri, mime: `image/${p.format}` }))
      onAttach({ kind: "photos", items })
      if (onSend) {
        try {
          const blocks = await Promise.all(items.map(packUriAsImageBlock))
          await onSend(blocks.filter((b): b is SendContentBlock => b !== null))
        } catch (err) {
          onError?.("error", err instanceof Error ? err.message : String(err))
        }
      }
      return
    }
    if (result.kind === "cancelled") return
    if (result.kind === "unsupported") {
      onError?.("unsupported", t("unsupported"))
      return
    }
    onError?.("error", result.message)
  }

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    if (files.length === 0) return
    onAttach({ kind: "files", files })
    if (onSend) {
      const images = files.filter((f) => f.type.startsWith("image/"))
      if (images.length > 0) {
        try {
          const blocks = await Promise.all(images.map(packFileAsImageBlock))
          const valid = blocks.filter((b): b is SendContentBlock => b !== null)
          if (valid.length > 0) await onSend(valid)
        } catch (err) {
          onError?.("error", err instanceof Error ? err.message : String(err))
        }
      }
    }
    closeMenu()
    e.target.value = "" // reset so the same files can be chosen again
  }

  const onVoiceStart = async () => {
    void selectionFeedback()
    const result = await withPlugin(voiceLoader, async (rec) => {
      const has = await rec.hasAudioRecordingPermission()
      const granted = has.value ? true : (await rec.requestAudioRecordingPermission()).value
      if (!granted) return { kind: "permission_denied" as const }
      const ok = await rec.startRecording()
      if (!ok.value) return { kind: "cannot_start" as const }
      return { kind: "started" as const }
    })
    if (result && "kind" in result && result.kind === "unsupported") {
      onError?.("unsupported", t("unsupported"))
      return
    }
    if (result && "kind" in result && result.kind === "error") {
      onError?.("error", result.message)
      return
    }
    if (result && "kind" in result && result.kind === "permission_denied") {
      onError?.("permission", t("permissionDeniedMic"))
      return
    }
    if (result && "kind" in result && result.kind === "cannot_start") {
      onError?.("error", t("voiceCannotStart"))
      return
    }
    setRecording(true)
  }

  const onVoiceStop = async () => {
    const result = await withPlugin(voiceLoader, async (rec) => rec.stopRecording())
    setRecording(false)
    closeMenu()
    if (result && "kind" in result && (result.kind === "unsupported" || result.kind === "error")) {
      onError?.("error", t("voiceStopFailed"))
      return
    }
    const v = (
      result as { value: { recordDataBase64: string; mimeType: string; msDuration: number } }
    ).value
    onAttach({
      kind: "voice",
      recordingDataUrl: `data:${v.mimeType};base64,${v.recordDataBase64}`,
      mimeType: v.mimeType,
      durationMs: v.msDuration,
    })
  }

  return (
    <div className={cn(className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("toggleAria")}
        aria-expanded={open}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        className="touch-target rounded-pill text-muted-foreground"
        data-testid="composer-plus-toggle"
      >
        {open ? <XIcon /> : <PlusIcon />}
      </Button>
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true)
          else closeMenu()
        }}
      >
        <DrawerContent
          role="menu"
          data-testid="composer-plus-menu"
          // The sheet's whole job is to hand focus back to the message: a row
          // that types `@issue:` is useless if closing the sheet then yanks
          // focus to the trigger and drops the caret (and, on iOS, the
          // keyboard) the panel needs.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t("toggleAria")}</DrawerTitle>
            <DrawerDescription>{t("sheetDescription")}</DrawerDescription>
          </DrawerHeader>
          {/* `min-h-0` is load-bearing: `DrawerContent` is a flex column capped at
              85vh, and a flex child defaults to `min-height:auto`, which refuses to
              shrink below its content. Without it the sheet does not scroll — it
              simply clips the last group off the bottom of the screen.

              The bottom gutter is 24px BEFORE the safe-area inset: the last row
              is a 44pt tap target, and on a phone with no inset to inherit
              (Android, a pre-notch iPhone) a 16px gutter put it inside the
              reach of the OS gesture bar. */}
          <div className="min-h-0 overflow-y-auto px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            {view === "docs" ? (
              <SubPanel title={tMenu("cloudDocs")} onBack={() => setView("root")}>
                {docsProviders.map((provider) => (
                  <PlusRow
                    key={provider.id}
                    icon={<CloudIcon className="size-4" />}
                    // Keyed by provider id so a newly registered provider needs
                    // one message, not a branch here; `registry-i18n.test.ts`
                    // pins the catalogue against the registry because
                    // `lint:i18n` cannot follow a template key.
                    label={tDocs(`name.${provider.id}` as "name.lark")}
                    onSelect={() => insertAndClose(`@${provider.mentionPrefix}`)}
                    testId={`composer-plus-docs-${provider.id}`}
                  />
                ))}
              </SubPanel>
            ) : view === "records" ? (
              <SubPanel title={tMenu("records")} onBack={() => setView("root")}>
                {entitySources.map((source) => (
                  <PlusRow
                    key={source.entityKind}
                    icon={<AtSignIcon className="size-4" />}
                    label={tEntities(source.entityKind as "issue")}
                    onSelect={() => insertAndClose(`@${source.prefix}`)}
                    testId={`composer-plus-record-${source.entityKind}`}
                  />
                ))}
              </SubPanel>
            ) : (
              <>
                <GroupLabel>{tMenu("attachGroup")}</GroupLabel>
                {/* Four across is the phone idiom and the widest that keeps a
                    one-line label at 320px — but the chat composer hides voice,
                    and three tiles in a four-column grid read as a missing
                    fourth rather than as three. */}
                <div
                  className={cn(
                    "grid gap-1 px-1",
                    showVoice && !recording ? "grid-cols-4" : "grid-cols-3"
                  )}
                >
                  <PlusTile
                    icon={<CameraIcon className="size-6" />}
                    label={t("camera")}
                    onSelect={onCamera}
                    testId="composer-plus-camera"
                  />
                  <PlusTile
                    icon={<ImageIcon className="size-6" />}
                    label={t("album")}
                    onSelect={onAlbum}
                    testId="composer-plus-album"
                  />
                  <label
                    className={cn(TILE_CLASS, "cursor-pointer")}
                    data-testid="composer-plus-file"
                  >
                    <FileIcon className="size-6" />
                    <span className="text-[11px] leading-tight">{t("file")}</span>
                    <input
                      type="file"
                      multiple
                      accept={fileAccept}
                      className="sr-only"
                      onChange={onFilePicked}
                      data-testid="composer-plus-file-input"
                    />
                  </label>
                  {showVoice && !recording ? (
                    <PlusTile
                      icon={<MicIcon className="size-6" />}
                      label={t("voice")}
                      onSelect={() => void onVoiceStart()}
                      testId="composer-plus-voice"
                    />
                  ) : null}
                </div>
                {showVoice && recording ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void onVoiceStop()}
                    className="mt-2 w-full gap-2"
                    data-testid="composer-plus-voice-stop"
                  >
                    <MicIcon className="animate-pulse" />
                    <span>{t("voiceStop")}</span>
                  </Button>
                ) : null}
                {/* A referenced record goes INTO the message, so it belongs to
                    this group — it is a row rather than a tile because it opens
                    a list instead of producing an attachment. */}
                {onInsert && docsProviders.length > 0 ? (
                  <PlusRow
                    icon={<CloudIcon className="size-4" />}
                    label={tMenu("cloudDocs")}
                    onSelect={() => setView("docs")}
                    chevron
                    testId="composer-plus-cloud-docs"
                  />
                ) : null}
                {onInsert && entitySources.length > 0 ? (
                  <PlusRow
                    icon={<AtSignIcon className="size-4" />}
                    label={tMenu("records")}
                    onSelect={() => setView("records")}
                    chevron
                    testId="composer-plus-records"
                  />
                ) : null}

                <GroupLabel className="mt-2 border-t border-border pt-3">
                  {tMenu("turnGroup")}
                </GroupLabel>
                <PlusRow
                  icon={<LightbulbIcon className="size-4" />}
                  label={tMenu("planMode")}
                  active={permissionMode === "plan"}
                  onSelect={() => {
                    setPermissionMode(
                      permissionMode === "plan" ? "default" : "plan",
                      composerSessionId
                    )
                    closeMenu()
                  }}
                  testId="composer-plus-plan-mode"
                />
                {onInsert ? (
                  <PlusRow
                    icon={<TargetIcon className="size-4" />}
                    label={tMenu("goal")}
                    onSelect={() => insertAndClose("/goal ")}
                    testId="composer-plus-goal"
                  />
                ) : null}
                {capabilities ? (
                  <div className="flex flex-wrap items-center gap-2 px-2 py-2">{capabilities}</div>
                ) : null}

                <GroupLabel className="mt-2 border-t border-border pt-3">
                  {tMenu("extendGroup")}
                </GroupLabel>
                {onInsert ? (
                  <PlusRow
                    icon={<SlashIcon className="size-4" />}
                    label={tMenu("slashCommands")}
                    onSelect={() => insertAndClose("/")}
                    testId="composer-plus-slash"
                  />
                ) : null}
                {onOpenExternalServices && chatServices.length > 0 ? (
                  <PlusRow
                    icon={<PlugIcon className="size-4" />}
                    label={tMenu("externalServices", { count: chatServices.length })}
                    onSelect={() => {
                      closeMenu()
                      onOpenExternalServices()
                    }}
                    testId="composer-plus-services"
                  />
                ) : null}
              </>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

/** 44pt floor on both axes — every row and tile in the sheet is thumb-sized. */
const TILE_CLASS =
  "flex min-h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-panel p-2 text-center text-[11px] font-normal leading-tight active:bg-muted/60"

const ROW_CLASS =
  "touch-target flex w-full items-center gap-3 rounded-control px-2 text-left text-sm active:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"

function GroupLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        className
      )}
    >
      {children}
    </p>
  )
}

/**
 * A drill-down panel: one back row, then the submenu's own items. The back row
 * is a full-width button so the way out is also the largest target — the same
 * reason the root entries are rows rather than a header with a chevron in it.
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
        className={cn(ROW_CLASS, "font-medium")}
        data-testid="composer-plus-back"
      >
        <ChevronLeftIcon className="size-4 text-muted-foreground" />
        <span className="flex-1">{title}</span>
      </button>
      <div className="mt-1 border-t border-border pt-1">{children}</div>
    </>
  )
}

function PlusTile({
  icon,
  label,
  onSelect,
  testId,
}: {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      data-testid={testId}
      className={TILE_CLASS}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function PlusRow({
  icon,
  label,
  onSelect,
  active,
  chevron,
  testId,
}: {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  active?: boolean
  /** Renders the "opens a submenu" affordance. */
  chevron?: boolean
  testId?: string
}) {
  // A row that carries state is a checkable menu item, not a pressed button:
  // `aria-pressed` is not defined for `menuitem`, so a screen reader would read
  // "Plan mode" with no indication that it is on.
  const checkable = active !== undefined
  return (
    <button
      type="button"
      role={checkable ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checkable ? active : undefined}
      onClick={onSelect}
      data-testid={testId}
      className={ROW_CLASS}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {active ? <span aria-hidden className="size-1.5 rounded-full bg-primary" /> : null}
      {chevron ? <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" /> : null}
    </button>
  )
}

