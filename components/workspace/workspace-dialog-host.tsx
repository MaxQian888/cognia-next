"use client"

/**
 * The always-mounted listener for workspace-editor requests.
 *
 * `useWorkspacePickerDialogs` owns the four editors and hands back an element
 * its caller must mount. Every existing caller is a Popover or a Drawer, which
 * unmount their children on close, so each mounts the element beside itself.
 * The command palette cannot: it closes before running an action, so an action
 * that opens a dialog has nowhere to put it.
 *
 * This component is that place. It renders nothing at all until the first
 * request arrives, at which point the real dialogs are loaded. That split
 * matters: the editors reach `useAdoptionCandidates`, which calls the host on
 * mount, and this component is mounted on every route in both shells.
 */

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"

import {
  onWorkspaceDialogRequest,
  type WorkspaceDialogKind,
} from "@/lib/workspace/workspace-dialog-request"

const WorkspaceDialogMount = dynamic(
  () => import("./workspace-dialog-mount").then((m) => m.WorkspaceDialogMount),
  { ssr: false }
)

export function WorkspaceDialogHost() {
  const [request, setRequest] = useState<{ kind: WorkspaceDialogKind; seq: number } | null>(null)

  useEffect(
    () =>
      onWorkspaceDialogRequest(({ kind }) => {
        // A monotonic sequence rather than the kind alone: asking for the same
        // editor twice in a row has to re-open it, and two identical objects
        // would not change the mount's prop identity.
        setRequest((previous) => ({ kind, seq: (previous?.seq ?? 0) + 1 }))
      }),
    []
  )

  if (!request) return null
  return <WorkspaceDialogMount request={request} />
}
