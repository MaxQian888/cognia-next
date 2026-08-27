import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { DriverHttpError, cleanupMessages, pollUntil, requestJson } from "./http.mjs"

/** A tiny real server: routing bugs in a hand-rolled fetch fake are invisible. */
async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("a JSON response is parsed and returned", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    },
    async (base) => {
      assert.deepEqual(await requestJson({ url: `${base}/x` }), { ok: true, path: "/x" })
    }
  )
})

test("a body is serialized and content-type is set", async () => {
  await withServer(
    (req, res) => {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            received: JSON.parse(Buffer.concat(chunks).toString()),
            type: req.headers["content-type"],
          })
        )
      })
    },
    async (base) => {
      const out = await requestJson({ url: base, method: "POST", body: { hello: "world" } })
      assert.deepEqual(out.received, { hello: "world" })
      assert.equal(out.type, "application/json")
    }
  )
})

test("a non-2xx carries the platform's own error body", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(403, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 99991672, msg: "no permission" }))
    },
    async (base) => {
      await assert.rejects(requestJson({ url: base }), (error) => {
        assert.ok(error instanceof DriverHttpError)
        assert.equal(error.status, 403)
        assert.equal(error.body.msg, "no permission")
        assert.match(error.message, /HTTP 403/)
        assert.match(error.message, /no permission/)
        return true
      })
    }
  )
})

test("an empty 204 is fine when JSON is not expected", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(204)
      res.end()
    },
    async (base) => {
      assert.equal(await requestJson({ url: base, method: "DELETE", expectJson: false }), undefined)
    }
  )
})

test("an HTML error page is reported as non-JSON, not silently swallowed", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<html>captive portal</html>")
    },
    async (base) => {
      await assert.rejects(requestJson({ url: base }), /non-JSON body/)
    }
  )
})

test("a hung endpoint fails with a timeout, not a hang", async () => {
  await withServer(
    () => {
      /* never responds */
    },
    async (base) => {
      await assert.rejects(requestJson({ url: base, timeoutMs: 120 }), (error) => {
        assert.ok(error instanceof DriverHttpError)
        assert.match(error.message, /timed out after 120ms/)
        return true
      })
    }
  )
})

test("a connection refusal names the method and url", async () => {
  await assert.rejects(requestJson({ url: "http://127.0.0.1:1/x", method: "POST" }), (error) => {
    assert.equal(error.method, "POST")
    assert.match(error.message, /POST http:\/\/127\.0\.0\.1:1\/x failed/)
    return true
  })
})

test("pollUntil returns the first non-empty result", async () => {
  let calls = 0
  const out = await pollUntil(async () => (++calls < 3 ? [] : ["found"]), {
    timeoutMs: 5000,
    intervalMs: 1,
    sleepImpl: async () => {},
  })
  assert.deepEqual(out, ["found"])
  assert.equal(calls, 3)
})

test("pollUntil returns null on timeout rather than throwing", async () => {
  let t = 0
  const out = await pollUntil(async () => [], {
    timeoutMs: 30,
    intervalMs: 10,
    now: () => (t += 10),
    sleepImpl: async () => {},
  })
  assert.equal(out, null)
})

test("pollUntil probes at least once even with a zero budget", async () => {
  let calls = 0
  await pollUntil(
    async () => {
      calls++
      return []
    },
    { timeoutMs: 0, sleepImpl: async () => {} }
  )
  assert.equal(calls, 1)
})

test("pollUntil stops when aborted", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const out = await pollUntil(
    async () => {
      calls++
      return ["x"]
    },
    { timeoutMs: 5000, signal: controller.signal, sleepImpl: async () => {} }
  )
  assert.equal(out, null)
  assert.equal(calls, 0)
})

test("cleanupMessages deletes what it can and reports what it could not", async () => {
  const result = await cleanupMessages(["a", null, "b", "c"], async (id) => {
    if (id === "b") throw new Error("message_not_found")
  })
  assert.deepEqual(result.deleted, ["a", "c"])
  assert.equal(result.retained.length, 1)
  assert.equal(result.retained[0].id, "b")
  assert.match(result.retained[0].reason, /message_not_found/)
  assert.equal(result.ok, false)
})

test("cleanupMessages over an empty list is a clean success", async () => {
  const result = await cleanupMessages([], async () => {
    throw new Error("must not be called")
  })
  assert.deepEqual(result, { deleted: [], retained: [], ok: true })
})
