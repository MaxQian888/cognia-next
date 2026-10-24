import {
  CALLBACK_PREFIXES,
  WF_FANOUT_APPROVE_PREFIX,
  WF_FANOUT_CANCEL_PREFIX,
  namespacedCallbackAction,
} from "./callback-prefixes"

it("pins every approval wire namespace, including the independently packaged workflow plugin", () => {
  expect(CALLBACK_PREFIXES).toEqual([
    "tapa:",
    "tapd:",
    "taps:",
    "tapr:",
    "plna:",
    "plnr:",
    "mgs:",
    "mga:",
    "mgd:",
    "wfapp:",
    "wfcan:",
    "wffanoutapp:",
    "wffanoutcan:",
    "skill_invoke:",
  ])
  expect(WF_FANOUT_APPROVE_PREFIX).toBe("wffanoutapp:")
  expect(WF_FANOUT_CANCEL_PREFIX).toBe("wffanoutcan:")
})

it.each(["tapd:", "plnr:", "mgd:", "wfcan:", "wffanoutcan:"])(
  "recovers cancel from %s on ID-only platforms",
  (prefix) => expect(namespacedCallbackAction(`${prefix}request`)).toBe("cancel")
)

it.each([undefined, null, 1, {}, "ordinary", "a2ui:surface:button:approve", "x:tapa:request"])(
  "does not classify an ordinary value %p as an approval",
  (value) => expect(namespacedCallbackAction(value)).toBeUndefined()
)
