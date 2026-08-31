"use client"

/**
 * Add a remote host from the fleet console itself.
 *
 * Until now the console's "Add host" action pushed
 * `/settings?section=remote-hosts`, and that section is `profiles: ["desktop"]`
 * (`settings-nav-config.ts`), so on web and mobile the button landed the user
 * on a settings empty state. The registry, the credential vault and
 * `CompanionTransport` all work off the desktop. Only the entry point did not.
 *
 * `ResponsiveDetailSheet` is the shared Sheet/Drawer switch, so this is a
 * right-hand sheet on desktop and a bottom drawer on a phone without either
 * shell knowing about the other.
 */

import { useTranslations } from "next-intl"

import { AddHostForm } from "@/components/settings/remote-hosts/add-host-form"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

export interface AddHostSheetProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Seeds the payload placeholder, e.g. from a `/servers` hand-off. */
  initialBaseUrl?: string
  /** Called with the new host so the console can select it straight away. */
  onPaired?: (host: RemoteHost) => void
}

export function AddHostSheet({ open, onOpenChange, initialBaseUrl, onPaired }: AddHostSheetProps) {
  const t = useTranslations("devices.addHost")

  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
    >
      <div className="overflow-y-auto px-4 pb-6" data-testid="add-host-sheet-body">
        <AddHostForm
          initialBaseUrl={initialBaseUrl}
          onPaired={(host) => {
            onPaired?.(host)
            // Closing on success is the honest end of the flow: the row now
            // exists in the list behind the sheet, and leaving the form open
            // invites a second pairing with a burnt one-shot invitation.
            onOpenChange(false)
          }}
        />
      </div>
    </ResponsiveDetailSheet>
  )
}
