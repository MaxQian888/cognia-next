import enContext from "@/i18n/messages/en/cliUiContext.json"
import zhContext from "@/i18n/messages/zh-CN/cliUiContext.json"
import enHooks from "@/i18n/messages/en/cliUiHooks.json"
import zhHooks from "@/i18n/messages/zh-CN/cliUiHooks.json"
import React, { createContext, useContext, useMemo } from "react"
import { createMessageResolver } from "@/lib/headless/i18n"
import enCommon from "@/i18n/messages/en/cliUiCommon.json"
import zhCommon from "@/i18n/messages/zh-CN/cliUiCommon.json"
import enApproval from "@/i18n/messages/en/cliUiApproval.json"
import zhApproval from "@/i18n/messages/zh-CN/cliUiApproval.json"
import enCommands from "@/i18n/messages/en/cliUiCommands.json"
import zhCommands from "@/i18n/messages/zh-CN/cliUiCommands.json"
import enDiff from "@/i18n/messages/en/cliUiDiff.json"
import zhDiff from "@/i18n/messages/zh-CN/cliUiDiff.json"
import enStartup from "@/i18n/messages/en/cliUiStartup.json"
import zhStartup from "@/i18n/messages/zh-CN/cliUiStartup.json"

import enSettings from "@/i18n/messages/en/cliUiSettings.json"
import zhSettings from "@/i18n/messages/zh-CN/cliUiSettings.json"

export type CliLocale = "en" | "zh-CN"
const LocaleContext = createContext<CliLocale>("en")
const messages = {
  en: {
    cliUiCommon: enCommon,
    cliUiApproval: enApproval,
    cliUiCommands: enCommands,
    cliUiDiff: enDiff,
    cliUiStartup: enStartup,
    cliUiSettings: enSettings,
    cliUiHooks: enHooks,
    cliUiContext: enContext,
  },
  "zh-CN": {
    cliUiCommon: zhCommon,
    cliUiApproval: zhApproval,
    cliUiCommands: zhCommands,
    cliUiDiff: zhDiff,
    cliUiStartup: zhStartup,
    cliUiSettings: zhSettings,
    cliUiHooks: zhHooks,
    cliUiContext: zhContext,
  },
}

/** Reuse the headless resolver and split catalogs without bundling desktop messages. */
export function createCliTranslator(locale: CliLocale | undefined, namespace: string) {
  const resolve = createMessageResolver(messages[locale ?? "en"])
  return (key: string, params?: Record<string, string | number>): string =>
    resolve(`${namespace}.${key}`, params)
}

export function CliI18nProvider({
  locale = "en",
  children,
}: {
  locale?: CliLocale
  children: React.ReactNode
}) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
}

export function useCliLocale(): CliLocale {
  return useContext(LocaleContext)
}

export function useCliTranslations(namespace: string) {
  const locale = useCliLocale()
  return useMemo(() => createCliTranslator(locale, namespace), [locale, namespace])
}
