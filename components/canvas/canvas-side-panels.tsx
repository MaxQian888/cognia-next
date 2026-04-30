"use client"

/**
 * Canvas Side Panels — replaces MemberList in the Canvas guild. Hosts
 * the Suggestions / History / Comments / Collaboration / Execution
 * tabs to the right of the editor. Wires the real Cognia panel
 * implementations so the dock has parity with Cognia's canvas surface.
 */

import { useTranslations } from "next-intl"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Lightbulb, History as HistoryIcon, MessageSquare, Users, Play } from "lucide-react"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { SuggestionsPanel } from "./suggestions-panel"
import { VersionHistoryPanel } from "./version-history-panel"
import { CommentPanel } from "./comment-panel"
import { CollaborationPanel } from "./collaboration-panel"
import { CodeExecutionPanel } from "./code-execution-panel"
import { useCanvasCodeExecution } from "@/hooks/canvas"

export function CanvasSidePanels() {
  const t = useTranslations("canvas.panels")
  const activeId = useArtifactStore((s) => s.activeCanvasId)

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        {t("emptyHint", { default: "Open a document to see suggestions, history and comments." })}
      </div>
    )
  }

  return (
    <Tabs defaultValue="suggestions" className="flex h-full flex-col">
      <TabsList className="flex h-auto w-full justify-start gap-0 rounded-none border-b bg-muted/30 p-0">
        <PanelTab
          value="suggestions"
          icon={<Lightbulb className="size-3.5" />}
          label={t("suggestions", { default: "Suggestions" })}
        />
        <PanelTab
          value="history"
          icon={<HistoryIcon className="size-3.5" />}
          label={t("history", { default: "History" })}
        />
        <PanelTab
          value="comments"
          icon={<MessageSquare className="size-3.5" />}
          label={t("comments", { default: "Comments" })}
        />
        <PanelTab
          value="collaboration"
          icon={<Users className="size-3.5" />}
          label={t("collaboration", { default: "Collab" })}
        />
        <PanelTab
          value="execution"
          icon={<Play className="size-3.5" />}
          label={t("execution", { default: "Run" })}
        />
      </TabsList>

      <TabsContent value="suggestions" className="m-0 flex-1 min-h-0 overflow-hidden">
        <SuggestionsHost documentId={activeId} />
      </TabsContent>
      <TabsContent value="history" className="m-0 flex-1 min-h-0 overflow-hidden">
        <HistoryHost documentId={activeId} />
      </TabsContent>
      <TabsContent value="comments" className="m-0 flex-1 min-h-0 overflow-hidden">
        <CommentsHost documentId={activeId} />
      </TabsContent>
      <TabsContent value="collaboration" className="m-0 flex-1 min-h-0 overflow-hidden">
        <CollaborationHost documentId={activeId} />
      </TabsContent>
      <TabsContent value="execution" className="m-0 flex-1 min-h-0 overflow-hidden">
        <ExecutionHost documentId={activeId} />
      </TabsContent>
    </Tabs>
  )
}

function PanelTab({ value, icon, label }: { value: string; icon: React.ReactNode; label: string }) {
  return (
    <TabsTrigger
      value={value}
      className="h-9 flex-1 rounded-none border-b-2 border-transparent px-2 text-xs data-[state=active]:border-primary data-[state=active]:bg-background"
    >
      <span className="flex items-center gap-1.5">
        {icon}
        <span className="truncate">{label}</span>
      </span>
    </TabsTrigger>
  )
}

/**
 * Wraps the Cognia SuggestionsPanel with the active document's
 * suggestions list pulled from the artifact store.
 */
function SuggestionsHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  const suggestions = doc?.aiSuggestions ?? []
  const pending = suggestions.filter((s) => s.status === "pending")
  if (pending.length === 0) {
    return (
      <p className="p-3 text-center text-xs text-muted-foreground">
        {t("suggestionsEmpty", {
          default: "No suggestions yet. Use the Suggest button on the toolbar.",
        })}
      </p>
    )
  }
  return <SuggestionsPanel documentId={documentId} suggestions={suggestions} />
}

/**
 * Renders the Cognia VersionHistoryPanel as a Sheet trigger button.
 * The panel itself opens its own Sheet with full diff support.
 */
function HistoryHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const getCanvasVersions = useArtifactStore((s) => s.getCanvasVersions)
  const versions = getCanvasVersions(documentId)
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <p className="text-xs text-muted-foreground">
          {t("historyHint", {
            default:
              "Snapshots are captured on every auto-save. Open the full panel for diff and restore.",
          })}
        </p>
        <VersionHistoryPanel
          documentId={documentId}
          trigger={
            <Button size="sm" className="w-full text-xs">
              <HistoryIcon className="mr-2 size-3.5" />
              {t("openHistory", { default: "Open history" })}{" "}
              <span className="ml-1 opacity-60">({versions.length})</span>
            </Button>
          }
        />
      </div>
    </div>
  )
}

/**
 * Renders the Cognia CommentPanel inside a Sheet trigger button.
 */
function CommentsHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">
        {t("commentsHint", {
          default: "Comments are line-anchored. Open the full panel to thread, react, and resolve.",
        })}
      </p>
      <CommentPanel
        documentId={documentId}
        trigger={
          <Button size="sm" className="w-full text-xs">
            <MessageSquare className="mr-2 size-3.5" />
            {t("openComments", { default: "Open comments" })}
          </Button>
        }
      />
    </div>
  )
}

/**
 * Mounts the Cognia CollaborationPanel content inline so the user
 * can see participants + connection state directly in the right rail.
 */
function CollaborationHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">
        {t("collabHint", {
          default:
            "Real-time collaboration is disabled by default. Enable it in Settings → Canvas → Collaboration and provide a CRDT signalling URL.",
        })}
      </p>
      <CollaborationPanel
        documentId={documentId}
        documentContent={doc?.content ?? ""}
        trigger={
          <Button size="sm" className="w-full text-xs">
            <Users className="mr-2 size-3.5" />
            {t("openCollab", { default: "Open collaboration" })}
          </Button>
        }
      />
    </div>
  )
}

/**
 * Mounts the Cognia CodeExecutionPanel inline. The hook performs the
 * sandboxed run via `lib/native/code-execution-strategy.ts` which
 * routes JS to an iframe and Python through the Tauri sidecar.
 */
function ExecutionHost({ documentId }: { documentId: string }) {
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  const language = doc?.language ?? "javascript"
  const { execute, cancel, clear, result, isExecuting } = useCanvasCodeExecution()
  return (
    <CodeExecutionPanel
      result={result}
      isExecuting={isExecuting}
      language={language}
      onExecute={() => void execute(doc?.content ?? "", language)}
      onCancel={() => cancel()}
      onClear={() => clear()}
      className="border-t-0"
    />
  )
}
