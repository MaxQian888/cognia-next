import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  PACKAGE_REFERENCES,
  SHARED_VECTORS,
  VENDORED_COPIES,
  contractProblems,
  pinProblems,
  readPin,
} from "./check-cognia-services.mjs"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const SHA = "a".repeat(40)
const OTHER = "b".repeat(40)

const packageUrl = (name, revision = SHA) =>
  `git+https://github.com/cognia-labs/cognia-services.git#${revision}&path:/packages/${name.replace("@cognia/", "")}`

/** A minimal app tree whose every pin spelling names `revision`. */
async function appFixture({ revision = SHA, cargoRev = revision, lockRev = revision } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cognia-services-app-"))
  await cp(resolve(REPO, "integrations"), join(root, "integrations"), { recursive: true })
  await writeFile(
    join(root, "integrations/cognia-services.json"),
    JSON.stringify({ repository: "cognia-labs/cognia-services", revision })
  )
  await writeFile(
    join(root, "Cargo.toml"),
    `[workspace.dependencies]\ncognia-signaling-core = { git = "https://github.com/cognia-labs/cognia-services", rev = "${cargoRev}" }\n`
  )
  await mkdir(join(root, "cli"))
  for (const [manifest, names] of Object.entries(PACKAGE_REFERENCES)) {
    const dependencies = Object.fromEntries(names.map((name) => [name, packageUrl(name, revision)]))
    await writeFile(join(root, manifest), JSON.stringify({ dependencies }))
  }
  await writeFile(
    join(root, "Cargo.lock"),
    `source = "git+https://github.com/cognia-labs/cognia-services?rev=${lockRev}#${lockRev}"\n`
  )
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    `version: https://codeload.github.com/cognia-labs/cognia-services/tar.gz/${lockRev}#path:/packages/sync-protocol\n`
  )
  return root
}

test("the repository's own pin is spelled the same everywhere", async () => {
  const pin = await readPin(REPO)
  assert.match(pin.revision, /^[a-f0-9]{40}$/)
  assert.deepEqual(await pinProblems(REPO), [])
})

test("a consistent fixture passes and every drifting spelling is named", async () => {
  const good = await appFixture()
  try {
    assert.deepEqual(await pinProblems(good), [])
  } finally {
    await rm(good, { recursive: true, force: true })
  }

  const cargo = await appFixture({ cargoRev: OTHER })
  try {
    const problems = await pinProblems(cargo)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /Cargo\.toml/)
  } finally {
    await rm(cargo, { recursive: true, force: true })
  }

  const lock = await appFixture({ lockRev: OTHER })
  try {
    const problems = await pinProblems(lock)
    assert.ok(problems.some((problem) => problem.startsWith("Cargo.lock")))
    assert.ok(problems.some((problem) => problem.startsWith("pnpm-lock.yaml")))
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
})

test("a package left on the workspace protocol is reported", async () => {
  const root = await appFixture()
  try {
    await writeFile(
      join(root, "cli/package.json"),
      JSON.stringify({ dependencies: { "@cognia/sync-protocol": "workspace:*" } })
    )
    const problems = await pinProblems(root)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /cli\/package\.json @cognia\/sync-protocol/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the pin file must name the services repository and a full revision", async () => {
  const root = await appFixture()
  try {
    await writeFile(
      join(root, "integrations/cognia-services.json"),
      JSON.stringify({ repository: "someone/else", revision: SHA })
    )
    await assert.rejects(readPin(root), /cognia-labs\/cognia-services/)
    await writeFile(
      join(root, "integrations/cognia-services.json"),
      JSON.stringify({ repository: "cognia-labs/cognia-services", revision: "d0b22ff" })
    )
    await assert.rejects(readPin(root), /40-hex/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Copies the app side of every contract into a fake services checkout. */
async function servicesFixture(app) {
  const services = await mkdtemp(join(tmpdir(), "cognia-services-checkout-"))
  for (const [appPath, servicesPath] of [...VENDORED_COPIES, ...SHARED_VECTORS]) {
    for (const target of [join(services, servicesPath), join(app, appPath)]) {
      await mkdir(dirname(target), { recursive: true })
      await cp(resolve(REPO, appPath), target)
    }
  }
  return services
}

test("contract copies must match the pinned checkout byte for byte", async () => {
  const app = await appFixture()
  const services = await servicesFixture(app)
  try {
    assert.deepEqual(await contractProblems(app, services, () => SHA), [])

    const [appPath, servicesPath] = VENDORED_COPIES[1]
    await writeFile(join(services, servicesPath), `${await readFile(join(app, appPath), "utf8")}\n`)
    const problems = await contractProblems(app, services, () => SHA)
    assert.equal(problems.length, 1)
    assert.match(problems[0], new RegExp(appPath.replaceAll(".", "\\.")))
  } finally {
    await rm(app, { recursive: true, force: true })
    await rm(services, { recursive: true, force: true })
  }
})

test("shared vectors compare by content, and the checkout must be the pinned revision", async () => {
  const app = await appFixture()
  const services = await servicesFixture(app)
  try {
    const [appPath, servicesPath] = SHARED_VECTORS[0]
    const vectors = JSON.parse(await readFile(join(services, servicesPath), "utf8"))
    vectors.note = "a different note is fine"
    await writeFile(join(services, servicesPath), JSON.stringify(vectors))
    assert.deepEqual(await contractProblems(app, services, () => SHA), [])

    vectors.vectors = vectors.vectors.slice(1)
    await writeFile(join(services, servicesPath), JSON.stringify(vectors))
    const problems = await contractProblems(app, services, () => OTHER)
    assert.equal(problems.length, 2)
    assert.match(problems[0], /not the pinned/)
    assert.match(problems[1], new RegExp(appPath.replaceAll(".", "\\.")))
  } finally {
    await rm(app, { recursive: true, force: true })
    await rm(services, { recursive: true, force: true })
  }
})
