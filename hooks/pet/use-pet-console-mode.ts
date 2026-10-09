// The live facts behind `resolvePetConsoleMode`: this window's platform and
// role, whether the pet tables here are a mirror, the runtime snapshot (what a
// paired host advertises), and the remote-host store (what a host this desktop
// is driving advertises). Re-resolves whenever any of them changes, so pairing
// or a host's manifest arriving flips the console without a reload.

"use client"

import { useMemo } from "react"
import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { resolvePetAvailability } from "@/lib/pet/access/availability"
import {
  PET_REMOTE_CARE_OPERATION,
  resolvePetConsoleMode,
  type PetConsoleModeResolution,
} from "@/lib/pet/console/console-mode"
import { isPetMirrorShell } from "@/lib/pet/remote/mirror"
import { getPetWindowRole } from "@/lib/pet/window-role"
import {
  useActiveHostSupportsFeature,
  useRemoteHostStore,
} from "@/stores/remote-host/remote-host-store"

export function usePetConsoleMode(): PetConsoleModeResolution {
  const platform = usePlatform()
  const snapshot = useRuntimeSnapshot()
  const activeRemoteHostSupportsPet = useActiveHostSupportsFeature(
    "pet.remote-care",
    PET_REMOTE_CARE_OPERATION
  )
  // Subscribed rather than read from the routing transport: activating a host
  // sets this id and installs its transport in the same store action, and a
  // render-time read of the transport would not re-render on that change.
  const remoteHostActive = useRemoteHostStore((state) => state.activeHostId !== null)
  return useMemo(
    () =>
      resolvePetConsoleMode({
        // The STRUCTURAL question only, the way `PetMount` asks it: whether the
        // user has the pet switched off is not asked, since the console is
        // where the pet's record lives and is worth reading either way.
        localAvailability: resolvePetAvailability({
          enabled: true,
          role: getPetWindowRole(),
          platform,
        }),
        mirror: isPetMirrorShell({ platform, remoteHostActive: () => remoteHostActive }),
        snapshot,
        activeRemoteHostSupportsPet,
      }),
    [platform, snapshot, activeRemoteHostSupportsPet, remoteHostActive]
  )
}
