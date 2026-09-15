# cognia-agent-bundle

The agent CLIs and `cognia-sandboxd`, packaged to be injected into whatever image a project runs in (ADR-0183). It is never run as a sandbox itself. A driver copies its tree into the sandbox's `/cognia` volume, probes the user image, and starts the agent through `cognia-sandboxd init-agent`.

## Layout

```
/opt/cognia/bundle-manifest.json   release tag, runtimes, libc per runtime (per architecture)
/opt/cognia/bin/cognia-sandboxd    static musl; also the image entrypoint
/opt/cognia/common/git/            static, relocatable git (RUNTIME_PREFIX), https via a static libcurl
/opt/cognia/common/bin/{git,rg}    reached on PATH from any image
/opt/cognia/certs/ca-bundle.pem    for images without a CA store
/opt/cognia/<libc>/node/           Node; on musl with its own loader, libstdc++ and libgcc_s
/opt/cognia/<libc>/lib/agents/     the npm tree (npm ci from npm/package-lock.json)
/opt/cognia/<libc>/runtimes/<id>/  verified vendor downloads (kiro-cli, droid)
/opt/cognia/<libc>/bin/            one entry per command
```

Staging happens in two steps, because the libc tree can only be chosen after the probe:

- `install --stage core` copies the manifest, `bin`, `common` and `certs`.
- `install --stage libc` copies the tree for the libc the probe reported.

## Why it is built this way

- **glibc tree.** Node is the official build and uses the image's glibc (2.28 or newer) and its `libstdc++`. The probe refuses images that lack either. Bundling a newer `libstdc++` would demand a newer glibc than many images have.
- **musl tree.** Node is patched (`patchelf`) to load the bundled musl loader and C++ runtime from `/cognia/musl/node/lib`. It therefore runs on Alpine base images, which ship no `libstdc++`, whatever musl release they have. Vendor musl binaries are not patched, because some carry payloads that patching would corrupt.
- **Shims.** JavaScript commands get a shell shim that names the bundled Node by absolute path, so `#!/usr/bin/env node` never picks up the project's own Node. Native commands are relative symlinks.
- **Install scripts.** `npm ci --ignore-scripts` runs first. Only the packages listed under `installScripts` in `agent-versions.json` are then rebuilt, each with a stated reason.
- **Integrity.** Every download is checked before use:
  - npm packages against the lock's sha512 integrity;
  - vendor binaries and ripgrep against the vendor-published sha256;
  - git against kernel.org's sha256;
  - curl, which publishes no checksum, by PGP signature from a pinned key fingerprint.

  A CLI whose vendor publishes no checksum is not bundled. It is listed as `unavailable` with the reason; cursor-agent is one.

- **Pins are not certification.** `agent-versions.json` never touches `certifiedVersions` in `protocol/external-agent-runtimes.json`. On a desktop a certified version runs without consent, and bundling a version is not a claim that it was certified.

## Changing a version

1. **npm CLI.** Edit the exact version in `npm/package.json`, then regenerate the lock and fill any integrity a shrinkwrap left out:

   ```bash
   cd deploy/bundle/npm && npm install --package-lock-only --ignore-scripts --no-audit --no-fund
   ```

   ```bash
   node scripts/build/bundle-agent-versions.mjs fill-integrity
   ```

   Update the runtime's `version` in `agent-versions.json`.

2. **Vendor binary, git, ripgrep.** Change the version, URL and sha256 together, taking the sha256 from the vendor's published checksum. For curl, change the version and URLs; keep `signingKey` unless curl's release key changes.

3. **Node or Alpine.** Change `node` in `agent-versions.json` and the matching `ARG` in the `Dockerfile`.

4. Run the checks:

   ```bash
   node scripts/build/bundle-agent-versions.mjs check
   ```

   ```bash
   node --test scripts/build/bundle-agent-versions.test.mjs
   ```

## Verification

The `agent-bundle` job in `.github/workflows/images.yml` does the following:

- checks the pins;
- builds amd64 and runs `smoke.sh` against `debian:bookworm-slim`, `python:3.12-slim`, `alpine:3.22` and `busybox:uclibc`, plus a non-root refusal case;
- builds amd64 and arm64 (QEMU).

Inside the image build, each libc stage runs every command once. The `assemble` stage then installs every tree with `cognia-sandboxd` itself, so a broken symlink or special file fails the build.
