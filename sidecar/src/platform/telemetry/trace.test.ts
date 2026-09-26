import assert from "node:assert/strict"
import test from "node:test"
import { ROOT_CONTEXT, propagation, trace } from "@opentelemetry/api"

import { parentContext, withTraceparent } from "./trace.ts"

test("extracts a valid W3C traceparent and makes it current", () => {
  propagation.setGlobalPropagator({
    inject() {},
    fields: () => ["traceparent"],
    extract(carrierContext, carrier) {
      const [, traceId = "", spanId = ""] = (carrier as { traceparent: string }).traceparent.split(
        "-"
      )
      return trace.setSpanContext(carrierContext, { traceId, spanId, traceFlags: 1 })
    },
  })
  const value = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
  assert.equal(trace.getSpanContext(parentContext(value))?.traceId, value.split("-")[1])
  let callbackRan = false
  withTraceparent(value, () => {
    callbackRan = true
  })
  assert.equal(callbackRan, true)
  propagation.disable()
  assert.equal(parentContext(undefined), ROOT_CONTEXT)
})
