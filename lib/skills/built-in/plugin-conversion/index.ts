import { z } from "zod"

import { getPluginConversionService } from "@/lib/plugin/convert/agent-service"
import type { PluginEcosystem } from "@/lib/plugin/convert/ecosystem"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillContext } from "../types"

const targetSchema = z.enum(["cognia", "claude-code", "codex", "gemini-cli"])

const inspectSchema = z.object({
  sourceDir: z
    .string()
    .min(1)
    .describe("Plugin bundle directory relative to the active workspace."),
  target: targetSchema.describe("Target plugin ecosystem."),
})

const applySchema = z.object({
  planId: z.string().min(1).describe("Opaque plan id returned by inspect_plugin_conversion."),
  outputDir: z
    .string()
    .min(1)
    .describe("Empty or non-existing output directory relative to the active workspace."),
})

function requireWorkspaceRoot(ctx: BuiltInSkillContext): string {
  const workspaceRoot = ctx.workspaceRoot?.trim()
  if (!workspaceRoot) {
    throw new Error("Plugin conversion requires an active desktop workspace.")
  }
  return workspaceRoot
}

const inspectSkill: BuiltInSkill<typeof inspectSchema> = {
  id: "plugin.conversion.inspect",
  family: "plugin.conversion",
  label: { en: "Inspect plugin conversion", "zh-CN": "检查插件转换" },
  description: {
    en: "Inspect a plugin bundle conversion, report fidelity and blocking issues, and create a source-bound plan without writing files.",
    "zh-CN": "检查插件包转换，报告保真度和阻塞问题，并生成绑定源快照且不写文件的计划。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "blocked",
  mcpToolName: "inspect_plugin_conversion",
  inputSchema: inspectSchema,
  execute: async (args, ctx) =>
    await getPluginConversionService().inspect({
      workspaceRoot: requireWorkspaceRoot(ctx),
      sourceDir: args.sourceDir,
      target: args.target as PluginEcosystem,
    }),
}

const applySkill: BuiltInSkill<typeof applySchema> = {
  id: "plugin.conversion.apply",
  family: "plugin.conversion",
  label: { en: "Apply plugin conversion", "zh-CN": "执行插件转换" },
  description: {
    en: "Apply a previously inspected plugin conversion to an empty workspace directory after desktop confirmation.",
    "zh-CN": "经桌面确认后，将已检查的插件转换写入工作区中的空目录。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "blocked",
  mcpToolName: "apply_plugin_conversion",
  inputSchema: applySchema,
  execute: async (args, ctx) =>
    await getPluginConversionService().apply({
      workspaceRoot: requireWorkspaceRoot(ctx),
      planId: args.planId,
      outputDir: args.outputDir,
    }),
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_plugin_conversion_apply_${Date.now().toString(36)}`,
      title: "Apply plugin conversion",
      summary: "Write the inspected deterministic conversion output to the active workspace.",
      details: [
        { label: "Output directory", value: args.outputDir },
        { label: "Plan", value: args.planId },
      ],
    }),
}

registerBuiltInSkill(inspectSkill)
registerBuiltInSkill(applySkill)

export { applySkill, inspectSkill }
