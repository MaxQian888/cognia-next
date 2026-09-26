"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { grantForCapability } from "@/lib/devices/grant-capabilities"
import type { DeviceGrantId } from "@/lib/devices/types"

/**
 * The namespace whose `col` is each grant's switch label in the device
 * console's Access tab (`components/devices/sections/access-section.tsx`).
 * Keyed so a new grant id is a type error here rather than a raw id on screen.
 */
const GRANT_NAMESPACE: Record<DeviceGrantId, string> = {
  control: "remoteControl",
  agentControl: "agentControl",
  terminal: "remoteTerminal",
  sshFiles: "sshFiles",
  lockedComputerUse: "lockedComputerUse",
}

/**
 * Turn a required capability ("git.write") into the name of the switch that
 * grants it ("Remote control"), for refusal copy like "This device is missing
 * the {grant} permission". The capability id is what the host reports, but the
 * device console never shows it, so a reader told "git.write" had nothing to
 * look for. `host.admin` gets a plain name too; any other capability no grant
 * carries falls back to its id.
 */
export function useCapabilityGrantLabel(): (capability: string | undefined) => string {
  const t = useTranslations("mobile.companion")
  return useCallback(
    (capability) => {
      if (!capability) return ""
      const grant = grantForCapability(capability)
      if (grant) return t(`${GRANT_NAMESPACE[grant]}.col` as never)
      // Not a console switch but the most common refusal on a phone: every
      // interactive command needs the host's approval lease.
      if (capability === "host.admin") return t("hostAdminCapability")
      return capability
    },
    [t]
  )
}
