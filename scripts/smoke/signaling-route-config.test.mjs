import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const repositoryRoot = new URL("../../", import.meta.url)

test("edge routing preserves both signaling endpoint generations", () => {
  const caddy = readFileSync(new URL("deploy/compose/Caddyfile", repositoryRoot), "utf8")
  const ingress = readFileSync(new URL("deploy/k8s/base/ingress.yaml", repositoryRoot), "utf8")

  for (const route of ["/signaling", "/v2/signaling"]) {
    assert.match(caddy, new RegExp(route.replaceAll("/", "\\/") + "\\*"))
    assert.match(ingress, new RegExp(`- path: ${route.replaceAll("/", "\\/")}\\n`))
  }
})

test("production signaling explicitly admits both bundled mobile origins", () => {
  const config = readFileSync(
    new URL("services/signaling-server/worker/wrangler.toml", repositoryRoot),
    "utf8"
  )
  const origins = config.match(/^SIGNALING_ALLOWED_ORIGINS = "([^"]*)"/m)?.[1].split(",")
  assert.ok(origins, "production origin allowlist exists")
  for (const origin of ["https://cognia.cn", "capacitor://localhost", "https://localhost"]) {
    assert.ok(origins.includes(origin), `missing shipped app origin: ${origin}`)
  }
  assert.ok(!origins.includes("*"))
  assert.ok(!origins.includes("null"))
})
