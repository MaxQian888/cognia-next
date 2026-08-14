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
