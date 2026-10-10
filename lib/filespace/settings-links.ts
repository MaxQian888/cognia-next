/**
 * Where a live-share surface sends someone to change what it cannot
 * (ADR-0222 §7.5): the file-sharing policy (Settings → Data → Backup, the
 * card `FileSharingPolicyCard` anchors) and the host's network drive
 * (Settings → Connectivity → Network drive).
 */

import { settingsHref } from "@/lib/settings/deep-link"

/** `data-setting-id` of the file-sharing policy card. */
export const FILE_SHARING_POLICY_SETTING_ID = "file-sharing-policy"

export function fileSharingPolicyHref(): string {
  return settingsHref("data", {
    focus: FILE_SHARING_POLICY_SETTING_ID,
    params: { dataTab: "backup" },
  })
}

export function networkDriveSettingsHref(): string {
  return settingsHref("connectivity", { params: { connectivityPanel: "network-drive" } })
}
