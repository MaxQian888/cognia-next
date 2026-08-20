import assert from "node:assert/strict"
import { test } from "node:test"

import { auditProIdeConstants } from "./check-pro-ide-constants.mjs"

const HASH = "sha256:abc"

const sources = (over = {}) => ({
  catalogJson: JSON.stringify({ catalogHash: HASH, codeApiVersion: "1.128.0" }),
  brokerProtocol: `const CODE_API_VERSION: &str = "1.128.0";\nconst DEFAULT_CATALOG_HASH: &str =\n    "${HASH}";`,
  extension: `const IDE_CATALOG_HASH = "${HASH}"`,
  process: 'const BROKER_EXT_VERSION: &str = "1.1.0";',
  extManifest: JSON.stringify({
    version: "1.1.0",
    publisher: "cognia",
    name: "cognia-managed-broker",
  }),
  proxy: 'const BROKER_EXTENSION_ID: &str = "cognia.cognia-managed-broker";',
  ...over,
})

test("passes when every copy agrees", () => {
  assert.deepEqual(auditProIdeConstants(sources()), [])
})

test("catches a stale catalog hash in Rust", () => {
  // Drifting here disables every managed plugin proxy at handshake time, with
  // nothing but a log line to say so.
  const problems = auditProIdeConstants(
    sources({
      brokerProtocol:
        'const CODE_API_VERSION: &str = "1.128.0";\nconst DEFAULT_CATALOG_HASH: &str = "sha256:stale";',
    })
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /DEFAULT_CATALOG_HASH is sha256:stale/)
})

test("catches a stale catalog hash in the extension", () => {
  const problems = auditProIdeConstants(
    sources({ extension: 'const IDE_CATALOG_HASH = "sha256:old"' })
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /IDE_CATALOG_HASH is sha256:old/)
})

test("catches a code API version that drifted from the contract", () => {
  const problems = auditProIdeConstants(
    sources({
      brokerProtocol: `const CODE_API_VERSION: &str = "1.99.0";\nconst DEFAULT_CATALOG_HASH: &str = "${HASH}";`,
    })
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /CODE_API_VERSION is 1\.99\.0/)
})

test("catches an extension bumped without the Rust constant", () => {
  // The host skips the side-load when its marker already records the declared
  // version, so this silently strands every machine on the old build.
  const problems = auditProIdeConstants(
    sources({
      extManifest: JSON.stringify({
        version: "1.2.0",
        publisher: "cognia",
        name: "cognia-managed-broker",
      }),
    })
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /never installs/)
})

test("catches a broker id the proxy generator would depend on wrongly", () => {
  const problems = auditProIdeConstants(
    sources({ proxy: 'const BROKER_EXTENSION_ID: &str = "cognia.cognia-agent-bridge";' })
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /BROKER_EXTENSION_ID is cognia\.cognia-agent-bridge/)
})

test("reports a moved declaration instead of silently passing", () => {
  // A renamed constant must fail loudly: a regex that matches nothing would
  // otherwise read as "everything agrees".
  const problems = auditProIdeConstants(sources({ process: "// the constant was renamed" }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /did the declaration move/)
})

test("reports a malformed contract hash", () => {
  const problems = auditProIdeConstants(
    sources({ catalogJson: JSON.stringify({ codeApiVersion: "1.128.0" }) })
  )
  assert.ok(problems.some((p) => /catalogHash is missing or malformed/.test(p)))
})

test("reports every drift at once rather than the first", () => {
  const problems = auditProIdeConstants(
    sources({
      extension: 'const IDE_CATALOG_HASH = "sha256:old"',
      proxy: 'const BROKER_EXTENSION_ID: &str = "cognia.wrong";',
    })
  )
  assert.equal(problems.length, 2)
})
