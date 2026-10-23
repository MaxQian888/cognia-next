#!/bin/sh
# End-to-end check of a built agent bundle against real user images (ADR-0183).
#
#   deploy/bundle/smoke.sh <bundle-image>
#
# Walks each image through what a Docker driver does — stage core into a
# volume, probe the image, stage the probed libc tree, run commands through
# `init-agent` — and checks the probe's verdict and exit code:
#
#   debian:bookworm-slim   glibc, every glibc runtime answers --version
#   python:3.12-slim       glibc without git: the bundled git serves https
#   alpine:3.22            musl, no libstdc++: Node runs on the bundled loader
#   busybox:uclibc         refused, probe_libc_unsupported (64)
#   python:3.12-slim as uid 10001 on a root-owned workspace: refused (68)
#
# Needs docker and node on the host (the runner); nothing else.
set -eu

bundle=$1
repo=$(cd "$(dirname "$0")/../.." && pwd)
pins="$repo/deploy/bundle/agent-versions.json"
manifest_dir=$(mktemp -d "${TMPDIR:-/tmp}/cognia-bundle-manifest.XXXXXX")
manifest_container=""
prefix="cognia-bundle-smoke-$$"
created=""

cleanup() {
  for volume in $created; do docker volume rm -f "$volume" >/dev/null 2>&1 || true; done
  if [ -n "$manifest_container" ]; then docker rm -f "$manifest_container" >/dev/null 2>&1 || true; fi
  rm -rf "$manifest_dir"
}
trap cleanup EXIT

fail() {
  echo "smoke: $*" >&2
  exit 1
}

new_volume() {
  name="$prefix-$1"
  docker volume create "$name" >/dev/null
  created="$created $name"
  new_volume_name=$name
}

release_case() {
  # Each libc tree is large; keep only the current case's volumes alive.
  # The exit trap still covers a failure before this point.
  docker volume rm "$injection" "$workspace" >/dev/null
}

# stage_and_probe <case> <image> [probe args...] -> sets $injection $workspace $probe_status
stage_and_probe() {
  case_name=$1
  image=$2
  shift 2
  new_volume "$case_name-cognia"
  injection=$new_volume_name
  new_volume "$case_name-workspace"
  workspace=$new_volume_name
  docker run --rm -v "$injection:/cognia" "$bundle" install --stage core --from /opt/cognia --to /cognia >/dev/null
  set +e
  docker run --rm -v "$injection:/cognia" -v "$workspace:/workspace" \
    --entrypoint /cognia/bin/cognia-sandboxd "$image" probe "$@" >/dev/null
  probe_status=$?
  set -e
}

probe_field() {
  # The bundle image has no shell; read probe.json through a throwaway busybox.
  docker run --rm -v "$injection:/cognia" busybox:stable cat /cognia/probe.json |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];console.log(Array.isArray(v)?v.join(" "):v??"")})' "$1"
}

in_image() {
  image=$1
  shift
  docker run --rm -v "$injection:/cognia" -v "$workspace:/workspace" \
    --entrypoint /cognia/bin/cognia-sandboxd "$image" init-agent -- "$@"
}

hosts_runtimes() {
  case_name=$1
  image=$2
  expected_libc=$3
  stage_and_probe "$case_name" "$image"
  [ "$probe_status" = 0 ] || fail "$image: probe exited $probe_status"
  libc=$(probe_field libc)
  [ "$libc" = "$expected_libc" ] || fail "$image: probed libc $libc, expected $expected_libc"
  echo "smoke: $image probed as $libc; runtimes: $(probe_field runtimes)"
  # The bootstrap executable must run before any Node/libc runtime is staged.
  docker run --rm -v "$injection:/cognia" --entrypoint /cognia/common/bin/cognia-bootstrap "$image" --version
  docker run --rm -v "$injection:/cognia" "$bundle" install --stage libc --from /opt/cognia --to /cognia >/dev/null
  in_image "$image" "/cognia/$libc/node/bin/node" --version
  version_commands=$(node --input-type=module - "$pins" "$manifest_dir/manifest.json" "$libc" <<'NODE'
import { readFileSync } from "node:fs"
const [pinsPath, manifestPath, libc] = process.argv.slice(2)
const pins = JSON.parse(readFileSync(pinsPath, "utf8"))
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
const commands = new Set()
for (const runtime of manifest.runtimes) {
  const pin = pins.runtimes.find(({ id }) => id === runtime.id)
  if (!pin || pin.version !== runtime.version) throw new Error(`unrecognized runtime pin ${runtime.id}@${runtime.version}`)
  if (!runtime.libc.includes(libc)) continue
  for (const command of runtime.commands) {
    const source = pin.commands?.find(({ name }) => name === command.name) ?? pin.archive ?? pin.binary
    if (source?.smoke === "version") commands.add(command.name)
  }
}
console.log([...commands].join(" "))
NODE
  )
  for command in $version_commands; do
    in_image "$image" "/cognia/$libc/bin/$command" --version >/dev/null || fail "$image: $command --version failed"
    echo "smoke: $image $libc/$command ok"
  done
  # Check the installed npm roots and shims, not merely the advertised set.
  in_image "$image" "/cognia/$libc/node/bin/node" -e '
    const fs = require("node:fs"), assert = require("node:assert/strict");
    const libc = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync("/cognia/bundle-manifest.json", "utf8"));
    const expected = [...new Set(manifest.runtimes.flatMap(r => r.commands.map(c => c.package).filter(Boolean)))].sort();
    const pkg = JSON.parse(fs.readFileSync(`/cognia/${libc}/lib/agents/package.json`, "utf8"));
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), expected);
    const commands = [...new Set(manifest.runtimes.filter(r => r.libc.includes(libc)).flatMap(r => r.commands.map(c => c.name)))].sort();
    assert.deepEqual(fs.readdirSync(`/cognia/${libc}/bin`).sort(), commands);
  ' "$libc"
  case " $(probe_field runtimes) " in
    *" codex-acp "*)
      node --input-type=module - "$repo" "$image" "$injection" "$workspace" "$libc" <<'NODE'
import { pathToFileURL } from "node:url"
const [repo, image, injection, workspace, libc] = process.argv.slice(2)
const { initializeAcp } = await import(pathToFileURL(`${repo}/deploy/runner/smoke.mjs`))
await initializeAcp(image, {
  runArgs: ["-v", `${injection}:/cognia`, "-v", `${workspace}:/workspace`],
  entrypoint: "/cognia/bin/cognia-sandboxd",
  args: ["init-agent", "--", `/cognia/${libc}/bin/codex-acp`],
})
console.log(`smoke: ${image} ${libc}/codex-acp initialize ok (offline)`)
NODE
      ;;
  esac
  in_image "$image" git --version
  in_image "$image" rg --version >/dev/null
}

# The image's manifest is authoritative for selected builds. Never assume the
# full repository runtime set was installed in this artifact.
manifest_container=$(docker create "$bundle")
docker cp "$manifest_container:/opt/cognia/bundle-manifest.json" "$manifest_dir/manifest.json" >/dev/null

hosts_runtimes debian debian:bookworm-slim glibc
release_case
hosts_runtimes python python:3.12-slim glibc
in_image python:3.12-slim git ls-remote https://github.com/git/git HEAD >/dev/null ||
  fail "python:3.12-slim: the bundled git cannot fetch over https"
release_case
hosts_runtimes alpine alpine:3.22 musl
release_case

stage_and_probe uclibc busybox:uclibc
[ "$probe_status" = 64 ] || fail "busybox:uclibc: probe exited $probe_status, expected 64"
echo "smoke: busybox:uclibc refused with 64"
release_case

stage_and_probe nonroot python:3.12-slim --user 10001
[ "$probe_status" = 68 ] || fail "python:3.12-slim --user 10001: probe exited $probe_status, expected 68"
echo "smoke: uid 10001 on a root-owned workspace refused with 68"
release_case

echo "smoke: all cases passed"
