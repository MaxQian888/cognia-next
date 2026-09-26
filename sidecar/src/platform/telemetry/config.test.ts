import assert from "node:assert/strict"
import test from "node:test"

import { langfuseTracingEnabled, parseHeaders, parsePostHogDestinations } from "./config.ts"

test("parses OTLP headers without putting them on argv", () => {
  assert.deepEqual(parseHeaders("Authorization=Basic abc==, x-tenant = one"), {
    Authorization: "Basic abc==",
    "x-tenant": "one",
  })
  assert.deepEqual(parseHeaders("ignored=x", '{"authorization":"Basic abc=="}'), {
    authorization: "Basic abc==",
  })
  assert.equal(parseHeaders(undefined), undefined)
})

test("rejects Personal API Keys and non-HTTP PostHog destinations", () => {
  assert.deepEqual(
    parsePostHogDestinations(
      JSON.stringify([
        { id: "byo", host: "https://posthog.example", projectToken: "phx_personal" },
        { id: "byo", host: "https://posthog.example", projectToken: "phc_" },
        { id: "byo", host: "https://posthog.example", projectToken: "phc_bad token" },
        { id: "byo", host: "file:///tmp/posthog", projectToken: "phc_project" },
      ])
    ),
    []
  )
  assert.deepEqual(
    parsePostHogDestinations(
      JSON.stringify([{ host: "https://us.i.posthog.com/", projectToken: " phc_test " }])
    ),
    [{ id: "posthog", host: "https://us.i.posthog.com", projectToken: "phc_test" }]
  )
  assert.deepEqual(parsePostHogDestinations("not json"), [])
})

test("Langfuse tracing needs all three credentials and no kill switch", () => {
  const credentials = {
    LANGFUSE_PUBLIC_KEY: "pk",
    LANGFUSE_SECRET_KEY: "sk",
    LANGFUSE_BASE_URL: "https://langfuse.example",
  }
  assert.equal(langfuseTracingEnabled(credentials), true)
  assert.equal(langfuseTracingEnabled({ ...credentials, LANGFUSE_SECRET_KEY: "" }), false)
  assert.equal(
    langfuseTracingEnabled({ ...credentials, COGNIA_LANGFUSE_TRACING_DISABLED: "1" }),
    false
  )
  assert.equal(
    langfuseTracingEnabled({ ...credentials, NEXT_PUBLIC_LANGFUSE_TRACING_DISABLED: "1" }),
    false
  )
})
