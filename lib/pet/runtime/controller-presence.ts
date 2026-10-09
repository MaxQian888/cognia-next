// Whether this webview's pet controller is subscribed to the event bus.
//
// `emitPetEvent` is fire-and-forget: with nothing subscribed, an event simply
// vanishes. That is fine for an ambient source, and wrong for a paired phone
// that asked the desktop to feed the pet and is waiting to be told what it
// earned. The companion bridge installs its listener at boot, well before
// `PetMount` has run its effects, so for a window of seconds after launch (and
// whenever the pet is switched off) a remote care action would be acknowledged
// and then dropped. `lib/pet/remote/host-dispatch.ts` reads this flag and
// answers `host-starting` instead.
//
// Set and cleared by `hooks/pet/use-pet-event-bus.ts`, the one place the
// controller subscribes. A counter rather than a boolean, so an overlapping
// remount (strict mode, a fast toggle) cannot clear the flag the surviving
// subscription still owns.
//
// Each edge (absent -> present, present -> absent) also invalidates the pet
// profile for paired devices. The flag itself lives in no table, so a phone
// whose last snapshot said `host-starting` (or that is still offering care
// buttons to a pet that was just switched off) would otherwise wait for its
// next focus or a later pet write to learn the answer changed. The phone's
// snapshot hook refetches on any pet-table invalidation
// (`hooks/pet/use-pet-remote-snapshot.ts`), and `publishSyncInvalidate`
// already stays silent where this webview is not the authoritative host.

import { publishSyncInvalidate } from "@/lib/sync/host-invalidate"

let subscriptions = 0

// Synchronous and never throws, so it cannot break the controller's mount; a
// lost frame only delays the phone until its next focus refresh.
function announce(): void {
  publishSyncInvalidate("petProfile")
}

/** Record that the controller subscribed. Returns the matching release. */
export function markPetControllerPresent(): () => void {
  subscriptions += 1
  if (subscriptions === 1) announce()
  let released = false
  return () => {
    if (released) return
    released = true
    subscriptions = Math.max(0, subscriptions - 1)
    if (subscriptions === 0) announce()
  }
}

/** True while at least one controller subscription is live in this webview. */
export function isPetControllerPresent(): boolean {
  return subscriptions > 0
}

/** Test helper: forget every subscription. */
export function __resetPetControllerPresenceForTesting(): void {
  subscriptions = 0
}
