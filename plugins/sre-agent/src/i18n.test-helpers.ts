/**
 * Test-only: register this plugin's bundle the way the manager does on enable
 * (flat keys from plugin.json, prefixed `plugin.sre-agent.`), so components
 * that call `usePluginTranslations` render real strings under test.
 */
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import manifestJson from "../plugin.json"
import { PLUGIN_ID } from "./ids"

export const EN_MESSAGES: Record<string, string> = manifestJson.i18n.locales.en
export const ZH_MESSAGES: Record<string, string> = manifestJson.i18n.locales["zh-CN"]

export function registerSreBundle(): void {
  const prefix = (dict: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(dict).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
    )
  registerPluginI18n({
    pluginId: PLUGIN_ID,
    messages: { en: prefix(EN_MESSAGES), "zh-CN": prefix(ZH_MESSAGES) },
  })
}

export function unregisterSreBundle(): void {
  unregisterPluginI18n(PLUGIN_ID)
}

/** English lookup with `{name}` interpolation — what the panel renders in the test host. */
export function en(key: string, params: Record<string, string | number> = {}): string {
  const template = EN_MESSAGES[key]
  if (template === undefined) throw new Error(`missing en key ${key}`)
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : String(params[name])
  )
}
