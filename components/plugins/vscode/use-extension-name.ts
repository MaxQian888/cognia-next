"use client"

import { useTranslations } from "next-intl"

import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

/** The display name of a VS Code extension plugin, for messages and labels. */
export function useExtensionName(pluginId: string): string {
  const t = useTranslations("plugins.vscodeWindow.extension")
  const name = usePluginStore((state) => state.plugins[pluginId]?.manifest.name)
  return name || pluginId || t("fallbackName")
}
