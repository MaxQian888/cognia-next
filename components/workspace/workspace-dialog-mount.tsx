"use client"

/**
 * The four workspace editors, and the request they were opened by.
 *
 * Split from `workspace-dialog-host.tsx` on purpose. `useWorkspacePickerDialogs`
 * reaches `useAdoptionCandidates`, which makes a host call on mount and pulls a
 * large module graph behind it. The host is mounted in both shells on every
 * route, so paying that at boot would be a real cost for a dialog most sessions
 * never open. This half loads only after the first request arrives.
 */

import { useEffect } from "react"

import { useWorkspacePickerDialogs } from "@/components/workspace/workspace-picker-list"
import type { WorkspaceDialogKind } from "@/lib/workspace/workspace-dialog-request"

export interface WorkspaceDialogMountProps {
  /** The request to act on. Changes identity per request, never per render. */
  request: { kind: WorkspaceDialogKind; seq: number } | null
}

export function WorkspaceDialogMount({ request }: WorkspaceDialogMountProps) {
  const { actions, element } = useWorkspacePickerDialogs()

  useEffect(() => {
    if (!request) return
    switch (request.kind) {
      case "openFolder":
        // The hook decides native chooser vs the host-filesystem picker.
        // Deciding it again here is how the palette ended up claiming
        // "desktop only" while the switcher offered the same thing.
        actions.openFolder()
        return
      case "newWorkspace":
        actions.newWorkspace()
        return
      case "adopt":
        actions.adopt()
        return
      case "manage":
        actions.manage()
        return
    }
    // `actions` is rebuilt every render by the hook, so keying the effect on it
    // would re-open the dialog on every keystroke inside it. The sequence
    // number is the identity of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [request])

  return element
}

export default WorkspaceDialogMount
