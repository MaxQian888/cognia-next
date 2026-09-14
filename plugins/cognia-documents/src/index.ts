import {
  defineExporter,
  defineImporter,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { exportTranscriptDocx, importDocx } from "./docx"
import { DOCUMENT_ARTIFACT_KIND, DOCX_MIME } from "./model"
import { createDocumentRenderer } from "./preview"
import { createDocumentsRuntime } from "./runtime"
import { createDocumentTools } from "./tools"

export const manifest = manifestJson as PluginManifest

const EN: Record<string, string> = {
  "documents.preview.review": "Review",
  "documents.preview.comments": "Comments",
  "documents.preview.changes": "Tracked changes",
  "documents.preview.validation": "Validation",
  "documents.preview.empty": "This document is empty.",
  "documents.preview.wordCount": "{count} words",
  "documents.preview.source": "Source: {name}",
  "documents.preview.open": "Open",
  "documents.preview.resolved": "Resolved",
  "documents.preview.pending": "Pending",
  "documents.preview.accepted": "Accepted",
  "documents.preview.resolve": "Resolve",
  "documents.preview.reopen": "Reopen",
  "documents.preview.accept": "Accept",
  "documents.preview.reject": "Reject",
  "documents.preview.showBlock": "Show block",
  "documents.preview.actionFailed": "Review action failed: {error}",
  "documents.importer.name": "Word document",
  "documents.importer.description": "Import DOCX into the Cognia document model.",
  "documents.exporter.name": "DOCX transcript",
  "documents.exporter.description": "Export this conversation as a Word document.",
  "documents.transcript.title": "Session transcript",
  "documents.transcript.user": "User",
  "documents.transcript.assistant": "Assistant",
  "documents.transcript.system": "System",
}

const ZH_CN: Record<string, string> = {
  "documents.preview.review": "审阅",
  "documents.preview.comments": "批注",
  "documents.preview.changes": "修订",
  "documents.preview.validation": "校验",
  "documents.preview.empty": "此文档为空。",
  "documents.preview.wordCount": "{count} 字",
  "documents.preview.source": "来源：{name}",
  "documents.preview.open": "待处理",
  "documents.preview.resolved": "已解决",
  "documents.preview.pending": "待审",
  "documents.preview.accepted": "已接受",
  "documents.preview.resolve": "标记已解决",
  "documents.preview.reopen": "重新打开",
  "documents.preview.accept": "接受",
  "documents.preview.reject": "拒绝",
  "documents.preview.showBlock": "定位段落",
  "documents.preview.actionFailed": "审阅操作失败：{error}",
  "documents.importer.name": "Word 文档",
  "documents.importer.description": "将 DOCX 导入为 Cognia 文档。",
  "documents.exporter.name": "DOCX 会话记录",
  "documents.exporter.description": "将当前会话导出为 Word 文档。",
  "documents.transcript.title": "会话记录",
  "documents.transcript.user": "用户",
  "documents.transcript.assistant": "助手",
  "documents.transcript.system": "系统",
}

function buildImporter(t: PluginContext["i18n"]["t"]) {
  return defineImporter({
    id: "docx",
    name: t("documents.importer.name"),
    description: t("documents.importer.description"),
    format: "docx",
    extensions: ["docx"],
    mimeType: DOCX_MIME,
    import: async (source) => {
      if (typeof source.content === "string")
        return { success: false, error: "DOCX import requires binary content." }
      try {
        return {
          success: true,
          data: await importDocx(new Uint8Array(source.content), source.filename),
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "DOCX import failed.",
        }
      }
    },
  })
}

function buildExporter(t: PluginContext["i18n"]["t"]) {
  return defineExporter({
    id: "docx",
    name: t("documents.exporter.name"),
    description: t("documents.exporter.description"),
    format: "docx",
    extension: "docx",
    mimeType: DOCX_MIME,
    export: (data) =>
      exportTranscriptDocx(data, {
        title: t("documents.transcript.title"),
        user: t("documents.transcript.user"),
        assistant: t("documents.transcript.assistant"),
        system: t("documents.transcript.system"),
      }),
  })
}

/** Disposers captured per activation context so `deactivate` can release them. */
const disposersByContext = new WeakMap<PluginContext, Array<() => void>>()

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    const disposers: Array<() => void> = []
    disposersByContext.set(ctx, disposers)
    ctx.i18n.registerTranslations("en", EN)
    ctx.i18n.registerTranslations("zh-CN", ZH_CN)

    const runtime = createDocumentsRuntime(ctx)
    const t = ctx.i18n.t

    disposers.push(
      ctx.artifact.registerRenderer(
        DOCUMENT_ARTIFACT_KIND,
        createDocumentRenderer({
          t,
          applyReview: (artifactId, expectedVersion, operations) =>
            runtime.apply({
              artifactId,
              expectedVersion,
              operations,
              changeDescription: "Review",
            }),
          onLocaleChange: (handler) => ctx.i18n.onLocaleChange(handler),
        })
      )
    )

    // Importer/exporter labels are resolved at registration time, so
    // re-register them when the locale changes.
    let disposeImporter = ctx.import.registerImporter(buildImporter(t))
    let disposeExporter = ctx.export.registerExporter(buildExporter(t))
    disposers.push(
      () => disposeImporter(),
      () => disposeExporter()
    )
    disposers.push(
      ctx.i18n.onLocaleChange(() => {
        disposeImporter()
        disposeExporter()
        disposeImporter = ctx.import.registerImporter(buildImporter(t))
        disposeExporter = ctx.export.registerExporter(buildExporter(t))
      })
    )

    for (const toolDef of createDocumentTools(ctx)) ctx.agent.registerTool(toolDef)
    ctx.logger.info("cognia-documents plugin activated")
  },
  deactivate: (ctx) => {
    for (const dispose of (ctx && disposersByContext.get(ctx)) ?? []) dispose()
    if (ctx) disposersByContext.delete(ctx)
    ctx?.logger.info("cognia-documents plugin deactivated")
  },
}

export default definition
