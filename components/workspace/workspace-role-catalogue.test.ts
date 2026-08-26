/**
 * Every `WorkspaceRole` must have a label, in both locales.
 *
 * `workspace-members.tsx` renders it with a **dynamic** key —
 * ``t(`role.${entry.membership.role}`)`` — which `pnpm lint:i18n` does not
 * see, so a fourth role would ship a badge reading `role.whatever` and pass
 * every gate.
 *
 * The list is walked from the runtime authority (`WORKSPACE_ROLES`) rather
 * than a hand-kept copy, so adding a role fails here on the day it is added.
 */

import en from "@/i18n/messages/en/workspace.json"
import zh from "@/i18n/messages/zh-CN/workspace.json"
import { WORKSPACE_ROLES } from "@/types/identity"

type Catalogue = { members: { role: Record<string, string> } }

const catalogues: Record<string, Catalogue> = {
  en: en as unknown as Catalogue,
  "zh-CN": zh as unknown as Catalogue,
}

describe("workspace.members.role.* catalogue", () => {
  it.each(Object.keys(catalogues))("%s labels every workspace role", (locale) => {
    const roles = catalogues[locale]!.members.role
    const missing = WORKSPACE_ROLES.filter((role) => typeof roles[role] !== "string")
    expect(missing).toEqual([])
  })

  it("gives each role a distinct label", () => {
    // A viewer and a maintainer reading the same word is a roster that cannot
    // be used for the one thing a roster is for.
    for (const locale of Object.keys(catalogues)) {
      const labels = WORKSPACE_ROLES.map((role) => catalogues[locale]!.members.role[role])
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})
