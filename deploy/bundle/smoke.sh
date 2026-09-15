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
script="$repo/scripts/build/bundle-agent-versions.mjs"
prefix="cognia-bundle-smoke-$$"
created=""

cleanup() {
  for volume in $created; do docker volume rm -f "$volume" >/dev/null 2>&1 || true; done
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
  echo "$name"
}

# stage_and_probe <case> <image> [probe args...] -> sets $injection $workspace $probe_status
stage_and_probe() {
  case_name=$1
  image=$2
  shift 2
  injection=$(new_volume "$case_name-cognia")
  workspace=$(new_volume "$case_name-workspace")
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
  docker run --rm -v "$injection:/cognia" "$bundle" install --stage libc --from /opt/cognia --to /cognia >/dev/null
  in_image "$image" "/cognia/$libc/node/bin/node" --version
  for command in $(node "$script" commands --pins "$pins" --libc "$libc"); do
    in_image "$image" "/cognia/$libc/bin/$command" --version >/dev/null || fail "$image: $command --version failed"
    echo "smoke: $image $libc/$command ok"
  done
  in_image "$image" git --version
  in_image "$image" rg --version >/dev/null
}

hosts_runtimes debian debian:bookworm-slim glibc
hosts_runtimes python python:3.12-slim glibc
in_image python:3.12-slim git ls-remote https://github.com/git/git HEAD >/dev/null ||
  fail "python:3.12-slim: the bundled git cannot fetch over https"
hosts_runtimes alpine alpine:3.22 musl

stage_and_probe uclibc busybox:uclibc
[ "$probe_status" = 64 ] || fail "busybox:uclibc: probe exited $probe_status, expected 64"
echo "smoke: busybox:uclibc refused with 64"

stage_and_probe nonroot python:3.12-slim --user 10001
[ "$probe_status" = 68 ] || fail "python:3.12-slim --user 10001: probe exited $probe_status, expected 68"
echo "smoke: uid 10001 on a root-owned workspace refused with 68"

echo "smoke: all cases passed"
