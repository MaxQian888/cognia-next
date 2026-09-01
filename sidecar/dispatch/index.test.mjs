import test from "node:test"
import assert from "node:assert/strict"

import { dispatch } from "./index.mjs"

/**
 * A frame naming a runtime this host cannot serve must say which of the two
 * things went wrong. `external` is a KNOWN adapter that lives in the renderer's
 * external-agent manager, so a turn arriving here with it was routed to the
 * wrong executor. Anything else is version skew between the resolver and this
 * host.
 */
test("refuses the external adapter by naming the executor it belongs to", () => {
  assert.throws(
    () => dispatch({ sendOptions: { execution: { runtimeAdapter: "external" } } }),
    /external-agent manager/
  )
})

test("refuses an adapter it has never heard of as skew", () => {
  assert.throws(
    () => dispatch({ sendOptions: { execution: { runtimeAdapter: "from-the-future" } } }),
    /unknown frozen runtimeAdapter: from-the-future/
  )
})
