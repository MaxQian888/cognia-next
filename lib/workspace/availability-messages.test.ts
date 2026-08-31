/**
 * The table's whole job is to be exhaustive. A state with no entry renders the
 * raw state name at the user, which is the failure this file exists to make
 * impossible.
 */

import { AVAILABILITY_MESSAGE_KEY } from "./availability-messages"
import type { OperationAvailabilityState } from "@/lib/runtime/operation-availability"

/**
 * Repeated here on purpose. Importing the union would make this test agree
 * with whatever the source says, which is not a check. Written out, adding a
 * state to `OperationAvailabilityState` fails the compile of the assignment
 * below until someone looks at both lists.
 */
const EVERY_STATE: readonly OperationAvailabilityState[] = [
  "available",
  "read-only",
  "queued",
  "offline",
  "requires-unlock",
  "requires-pairing",
  "requires-grant",
  "incompatible",
  "unsupported",
]

describe("AVAILABILITY_MESSAGE_KEY", () => {
  it("covers every availability state", () => {
    const missing = EVERY_STATE.filter((state) => !AVAILABILITY_MESSAGE_KEY[state])
    expect({ scanned: EVERY_STATE.length, missing }).toEqual({ scanned: 9, missing: [] })
  })

  it("has an entry for every key the table declares, and no extras", () => {
    expect(Object.keys(AVAILABILITY_MESSAGE_KEY).sort()).toEqual([...EVERY_STATE].sort())
  })

  it("resolves every key against both shipped locales", () => {
    for (const locale of ["en", "zh-CN"]) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const messages = require(`@/i18n/messages/${locale}/workspace.json`) as Record<string, never>
      const namespace = messages.actionErrors as unknown as Record<string, unknown>
      for (const key of Object.values(AVAILABILITY_MESSAGE_KEY)) {
        const value = key
          .split(".")
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown> | undefined)?.[part],
            namespace
          )
        expect({ locale, key, resolved: typeof value }).toEqual({
          locale,
          key,
          resolved: "string",
        })
      }
    }
  })
})
