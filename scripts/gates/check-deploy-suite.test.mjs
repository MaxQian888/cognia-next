import test from "node:test"
import assert from "node:assert/strict"

import {
  COMPOSE_BASE,
  COMPOSE_T2,
  checkComposeImagesPublished,
  checkComposePortsParametrized,
  checkInstanceScoping,
  checkNodeBases,
  checkRustBases,
  checkWorkflowPnpmPins,
  composeDefault,
  fromImages,
  ghcrImageName,
  hostPortSide,
  loadRepoInputs,
  publishedImageNames,
  runChecks,
  toolchainChannel,
} from "./check-deploy-suite.mjs"

const GOOD_BASE = `
name: \${COGNIA_INSTANCE:-cognia}
services:
  signaling:
    image: \${SIGNALING_IMAGE:-ghcr.io/owner/cognia-signaling:latest}
    ports:
      - "\${COGNIA_BIND_ADDRESS:-0.0.0.0}:\${SIGNALING_PORT:-7892}:7892"
  cognia-server:
    image: \${COGNIA_SERVER_IMAGE:-ghcr.io/owner/cognia-server:latest-full}
    environment:
      COGNIA_DEPLOYMENT_ID: \${COGNIA_INSTANCE:-cognia}
    ports:
      - "\${COGNIA_BIND_ADDRESS:-0.0.0.0}:\${COGNIA_SERVER_PORT:-27890}:27890"
  caddy:
    image: \${COGNIA_WEB_IMAGE:-ghcr.io/owner/cognia-web:latest}
    ports:
      - "\${COGNIA_HTTPS_PORT:-443}:443/udp"
  prometheus:
    image: prom/prometheus:v3.5.0
`

const GOOD_T2 = `
services:
  cognia-server:
    environment:
      COGNIA_WORKSPACES_VOLUME: \${COGNIA_INSTANCE:-cognia}_workspaces
  workspace-runtime-default:
    image: \${COGNIA_WORKSPACE_RUNTIME_IMAGE:-ghcr.io/owner/cognia-workspace-runtime:latest}
volumes:
  cognia_workspaces:
    name: \${COGNIA_INSTANCE:-cognia}_workspaces
`

const GOOD_IMAGES_WORKFLOW = `
jobs:
  fast-images:
    strategy:
      matrix:
        include:
          - name: cognia-signaling
          - name: cognia-web
          - name: cognia-workspace-runtime
  cognia-server-image:
    steps:
      - uses: docker/metadata-action@v6
        with:
          images: ghcr.io/\${{ needs.vars.outputs.owner }}/cognia-server
`

const GOOD_RUST = {
  "Dockerfile.a": "FROM rust:1.95-bookworm AS builder\nFROM debian:bookworm-slim\n",
  "Dockerfile.b":
    "FROM registry.k8s.io/kubectl:v1 AS kubectl\nFROM rust:1.95.0-bookworm AS builder\n",
}

const GOOD_NODE = {
  "Dockerfile.web":
    "FROM node:26-bookworm AS web-build\nARG PNPM_VERSION=11.18.0\nRUN npm i -g pnpm@${PNPM_VERSION}\nFROM caddy:2.10\n",
}

const GOOD_INPUTS = {
  channel: "1.95",
  enginesNode: ">=26.0.0",
  packageManager: "pnpm@11.18.0",
  rustDockerfiles: GOOD_RUST,
  nodeDockerfiles: GOOD_NODE,
  composeFiles: { [COMPOSE_BASE]: GOOD_BASE, [COMPOSE_T2]: GOOD_T2 },
  imagesWorkflow: GOOD_IMAGES_WORKFLOW,
  workflows: {
    "a.yml": "jobs:\n  x:\n    steps:\n      - uses: pnpm/action-setup@v6\n",
    "b.yml":
      "jobs:\n  y:\n    steps:\n      - uses: pnpm/action-setup@v6\n        with:\n          version: 11.18.0\n",
  },
}

test("a coherent suite passes every check", () => {
  assert.deepEqual(runChecks(GOOD_INPUTS), [])
})

test("the checked-in repository passes", () => {
  assert.deepEqual(runChecks(loadRepoInputs()), [])
})

test("toolchainChannel reads the pin", () => {
  assert.equal(toolchainChannel('[toolchain]\nchannel = "1.95"\n'), "1.95")
  assert.throws(() => toolchainChannel("[toolchain]\n"))
})

test("fromImages sees every stage base, including --platform", () => {
  assert.deepEqual(
    fromImages("FROM --platform=$BUILDPLATFORM rust:1.95 AS a\nfrom node:26 as b\n"),
    ["rust:1.95", "node:26"]
  )
})

// The real drift: two Dockerfiles stayed on rust:1.89 after the workspace
// pin moved to 1.95, and their `--locked` builds resolve the shared lockfile.
test("a Rust base behind the toolchain pin is a problem", () => {
  const problems = checkRustBases({
    dockerfiles: { "Dockerfile.old": "FROM rust:1.89-bookworm AS builder\n" },
    channel: "1.95",
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /rust:1\.89-bookworm/)
  assert.match(problems[0], /pins 1\.95/)
})

test("a patch-level rust tag on the same channel is fine", () => {
  assert.deepEqual(
    checkRustBases({ dockerfiles: { d: "FROM rust:1.95.0-slim\n" }, channel: "1.95" }),
    []
  )
})

// node:22 shipped for the web image against an engines.node >= 26 workspace.
test("a Node base below engines.node is a problem", () => {
  const problems = checkNodeBases({
    dockerfiles: { d: "FROM node:22-alpine\nARG PNPM_VERSION=11.18.0\n" },
    enginesNode: ">=26.0.0",
    packageManager: "pnpm@11.18.0",
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /node:22-alpine/)
})

test("a missing or mismatched pnpm pin is a problem", () => {
  const missing = checkNodeBases({
    dockerfiles: { d: "FROM node:26\nRUN corepack enable\n" },
    enginesNode: ">=26",
    packageManager: "pnpm@11.18.0",
  })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /ARG PNPM_VERSION/)

  const mismatched = checkNodeBases({
    dockerfiles: { d: "FROM node:26\nARG PNPM_VERSION=10.28.2\n" },
    enginesNode: ">=26",
    packageManager: "pnpm@11.18.0",
  })
  assert.equal(mismatched.length, 1)
  assert.match(mismatched[0], /10\.28\.2/)
})

test("composeDefault unwraps both default forms and passes literals through", () => {
  assert.equal(composeDefault("${X:-ghcr.io/o/a:1}"), "ghcr.io/o/a:1")
  assert.equal(composeDefault("${X-ghcr.io/o/a:1}"), "ghcr.io/o/a:1")
  assert.equal(composeDefault("postgres:17-alpine"), "postgres:17-alpine")
  assert.equal(composeDefault("${X:?required}"), "${X:?required}")
  assert.equal(composeDefault(undefined), undefined)
})

test("ghcrImageName extracts the repository leaf only for ghcr references", () => {
  assert.equal(ghcrImageName("ghcr.io/maxqian888/cognia-web:latest"), "cognia-web")
  assert.equal(ghcrImageName("ghcr.io/o/cognia-server@sha256:" + "a".repeat(64)), "cognia-server")
  assert.equal(ghcrImageName("ghcr.io/o/cognia-server"), "cognia-server")
  assert.equal(ghcrImageName("postgres:17-alpine"), undefined)
  assert.equal(ghcrImageName("${X:?required}"), undefined)
})

test("publishedImageNames unions the matrix and the metadata images", () => {
  assert.deepEqual([...publishedImageNames(GOOD_IMAGES_WORKFLOW)].sort(), [
    "cognia-server",
    "cognia-signaling",
    "cognia-web",
    "cognia-workspace-runtime",
  ])
})

// cognia-web was the compose default for the tls profile and a hard
// requirement of the production override, and nothing built it.
test("a compose default image nobody publishes is a problem", () => {
  const problems = checkComposeImagesPublished({
    composeFiles: { [COMPOSE_BASE]: GOOD_BASE },
    imagesWorkflow:
      "jobs:\n  fast-images:\n    strategy:\n      matrix:\n        include:\n          - name: cognia-signaling\n",
  })
  assert.equal(problems.length, 2)
  assert.ok(problems.some((p) => p.includes("cognia-web")))
  assert.ok(problems.some((p) => p.includes("cognia-server")))
})

test("hostPortSide keeps the bind address and drops the protocol", () => {
  assert.equal(hostPortSide("0.0.0.0:${A:-80}:80"), "0.0.0.0:${A:-80}")
  assert.equal(hostPortSide("${A:-443}:443/udp"), "${A:-443}")
  assert.equal(hostPortSide("27891:27890"), "27891")
  assert.equal(hostPortSide("27890"), "")
})

test("a literal host port is a problem", () => {
  const problems = checkComposePortsParametrized({
    composeText: 'services:\n  s:\n    ports:\n      - "7892:7892"\n      - "${P:-1}:1"\n',
    rel: "x.yml",
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /"7892:7892"/)
})

test("long-syntax ports are refused because the host side is not inspectable", () => {
  const problems = checkComposePortsParametrized({
    composeText: "services:\n  s:\n    ports:\n      - target: 80\n        published: 8080\n",
    rel: "x.yml",
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /long syntax/)
})

test("instance scoping requires the project, the deployment label and the T2 volume to derive from COGNIA_INSTANCE", () => {
  const fixedProject = GOOD_BASE.replace("name: ${COGNIA_INSTANCE:-cognia}", "name: cognia")
  assert.equal(checkInstanceScoping({ baseText: fixedProject, t2Text: GOOD_T2 }).length, 1)

  const noDeployment = GOOD_BASE.replace(
    "COGNIA_DEPLOYMENT_ID: ${COGNIA_INSTANCE:-cognia}",
    "COGNIA_DEPLOYMENT_ID: cognia"
  )
  const problems = checkInstanceScoping({ baseText: noDeployment, t2Text: GOOD_T2 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /COGNIA_DEPLOYMENT_ID/)

  const fixedVolume = GOOD_T2.replace(
    "name: ${COGNIA_INSTANCE:-cognia}_workspaces",
    "name: cognia_workspaces"
  )
  const volumeProblems = checkInstanceScoping({ baseText: GOOD_BASE, t2Text: fixedVolume })
  assert.equal(volumeProblems.length, 2, volumeProblems.join("\n"))
  assert.ok(volumeProblems.some((p) => p.includes("does not derive")))
  assert.ok(volumeProblems.some((p) => p.includes("must equal")))
})

// compose-e2e.yml pinned pnpm 10.28.2 against a pnpm 11 lockfile.
test("a workflow pnpm pin that differs from packageManager is a problem", () => {
  const problems = checkWorkflowPnpmPins({
    workflows: {
      "w.yml":
        "jobs:\n  j:\n    steps:\n      - uses: pnpm/action-setup@v5\n        with:\n          version: 10.28.2\n",
    },
    packageManager: "pnpm@11.18.0",
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /10\.28\.2/)
  assert.match(problems[0], /job "j"/)
})
