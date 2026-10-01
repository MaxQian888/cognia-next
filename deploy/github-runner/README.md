# GitHub Actions temporary Hosts

[English](README.md) | [简体中文](README.zh-CN.md)

A GitHub-hosted Linux runner can provision a temporary Cognia Host. Provisioning is
owned by the local desktop; terminal, files, Git, Agent processes and environments
use the existing authenticated Companion protocol after pairing. There is no SSH
transport or separate GitHub Agent runtime.

## Install the runner template

Use a repository where your GitHub account can dispatch Actions workflows. The
desktop uses the existing `gh` login for **github.com**. GitHub Enterprise Server
is not supported by this artifact protocol.

Copy these files without modification into the provisioner repository:

| Source in this directory | Destination                               |
| ------------------------ | ----------------------------------------- |
| `cognia-runner.yml`      | `.github/workflows/cognia-runner.yml`     |
| `action.yml`             | `.github/cognia-runner/action.yml`        |
| `bootstrap.mjs`          | `.github/cognia-runner/bootstrap.mjs`     |
| `package.json`           | `.github/cognia-runner/package.json`      |
| `package-lock.json`      | `.github/cognia-runner/package-lock.json` |

Commit the files to the default branch first so GitHub recognizes the dispatchable
workflow. Set the repository Actions variable `COGNIA_RUNNER_ACTORS` to a JSON
array of allowed GitHub logins, for example `["your-login"]`. An unset or empty
allowlist refuses all runs. Organization repositories use the same explicit
allowlist. The desktop verifies the five files against its bundled template at the
selected branch's commit before dispatch. Update them together when updating the
desktop; customize the images and project environments rather than modifying the
control script.

The workflow checks out only its bootstrap code with Git credentials persistence
disabled. Project source, conversation context, model keys, plugin credentials and
pairing secrets are not dispatch inputs. The Host does not inherit the Actions
token or artifact runtime token.

## Create and connect

Open **Settings → Connectivity → Remote hosts → GitHub runner environments**.
The wizard has three steps:

1. **Repository.** Enter `owner/repo` or paste an `https://github.com/owner/repo`
   repository URL; Cognia normalizes it to `owner/repo`. Choose a workflow
   **branch**, not a tag. Select **Check and continue** to check the local `gh`
   executable, current GitHub account, repository write access and active status,
   branch commit, active workflow, and all five files against the bundled template.
   These checks only read GitHub; they do not dispatch a job. Fix any reported
   issue and check again. Changing the repository or branch requires a new check.
2. **Environment.** Name the environment and choose 60, 120 or 240 minutes, or enter
   a custom integer from 10 to 330. Supply three published Linux amd64 images:
   the Cognia Host, Agent bundle and development image. Each must use
   `image@sha256:<64 lowercase hex digits>`. Enter a reachable Cognia signaling
   relay using `wss://…`, without credentials, query parameters or a fragment.
   The wizard does not build or publish images. Select **Review configuration**.
3. **Review.** Check all eight fields and the GitHub account, then explicitly
   select **Create environment**. The receipt records the request; it does not
   establish that the Host has started. Follow the status below through queue and
   preparation. At **Ready to connect**, select **Connect** to pair with the Host.

Before checking, install GitHub CLI, run `gh auth login` on this computer, and
install all five templates using the instructions above. A passed check does
**not** verify `COGNIA_RUNNER_ACTORS`, organization Actions policies, image
availability or relay connectivity. Configure the actor allowlist and confirm
these deployment requirements separately. Checks have a 90-second overall limit;
a timeout or API failure can reflect connectivity as well as authentication.

Build the Host from `Dockerfile.cognia-server` and the Agent bundle from
`deploy/bundle/Dockerfile`. Use `runtime-full` for preinstalled native Agent CLIs
on the Host; `runtime-slim` provides headless services. The development image
supplies project tools. Publish all three images where the runner can pull them,
using the optional registry secret below if necessary, and ensure their Linux
amd64 architecture and libc compatibility.

The last valid submitted configuration is restored with a notice. **Reset form**
clears the current form; editing alone does not replace the saved preset. Only
the eight public fields are saved locally, with no pairing credentials. Storage
unavailability does not prevent creation. For errors or an uncertain request,
use **Refresh status** and **View GitHub run** before submitting another request;
fix preflight failures and use **Check and continue** to retry them.

Pairing verifies the Host fingerprint, stores device credentials through the
shared vault and adds the Host to the normal Remote Host registry. Connecting
switches the desktop's active execution Host. Prepare or transfer the workspace
and configure the Agent/model before running your project. Provisioning controls
remain on the local desktop even while this remote Host is selected.

## Build, publish, and obtain immutable image references

Run builds from the Cognia repository root with Docker Buildx. Replace the namespace and release tag with registries you can publish to; authenticate the build machine using your normal registry login. These are examples to execute in your own environment, not prepublished image references.

```bash
export RUNNER_IMAGE_NAMESPACE=ghcr.io/your-owner
export RUNNER_IMAGE_TAG=your-release

docker buildx build --platform linux/amd64 --target runtime-full \
  -f Dockerfile.cognia-server \
  -t "$RUNNER_IMAGE_NAMESPACE/cognia-host:$RUNNER_IMAGE_TAG" --push .

docker buildx build --platform linux/amd64 -f deploy/bundle/Dockerfile \
  --build-arg BUNDLE_RELEASE_TAG="$RUNNER_IMAGE_TAG" \
  -t "$RUNNER_IMAGE_NAMESPACE/cognia-agent-bundle:$RUNNER_IMAGE_TAG" --push .

docker buildx build --platform linux/amd64 -f Dockerfile.project \
  -t "$RUNNER_IMAGE_NAMESPACE/cognia-development:$RUNNER_IMAGE_TAG" --push .
```

`Dockerfile.project` is your project's development image, not an included file. Start from a base compatible with your tools and the bundle's libc probe, install stable dependencies there, and retain `/bin/sh`. Pin the base and dependencies for reproducible builds. Use `runtime-slim` instead of `runtime-full` only when you do not need the latter's preinstalled native Agent CLIs. The Agent bundle Dockerfile uses its final image directly; it has no `runtime-full` target. See the [bundle contract](../bundle/README.md) for libc, runtime availability, and compatibility constraints.

Inspect each pushed reference:

```bash
docker buildx imagetools inspect "$RUNNER_IMAGE_NAMESPACE/cognia-host:$RUNNER_IMAGE_TAG"
docker buildx imagetools inspect "$RUNNER_IMAGE_NAMESPACE/cognia-agent-bundle:$RUNNER_IMAGE_TAG"
docker buildx imagetools inspect "$RUNNER_IMAGE_NAMESPACE/cognia-development:$RUNNER_IMAGE_TAG"
```

Copy each reported `Digest: sha256:…` into its corresponding UI field as `ghcr.io/your-owner/image@sha256:…`. The tag is for publishing and inspection; the create form requires the immutable digest. An index digest is acceptable only when the image includes Linux amd64. Build/push success alone does not verify live runner startup or an authenticated Agent session.

## Optional private registry access

In the provisioner repository's **Actions secrets**, set `COGNIA_RUNNER_REGISTRY_AUTH` to a Docker-config JSON object. Use credentials limited to reading the required images, for example:

```json
{
  "auths": {
    "ghcr.io": {
      "username": "read-user",
      "password": "read-only-token"
    }
  }
}
```

Alternatively, an entry may contain only `auth` with Base64-encoded `username:password`, only `identitytoken`, or only `registrytoken`. Do not combine these forms. The top-level object accepts only `auths`, with at most 32 registries and 48 KiB of JSON. Credential helper configuration such as `credsStore` or `credHelpers` is rejected. An absent or empty secret uses anonymous pulls.

This is an Actions secret, not a desktop field or dispatch input. Bootstrap writes an isolated `0600` Docker config for the three parallel image pulls, then removes it after setup succeeds or fails. A read-only helper mount copies a `0600`, UID 10001-owned file into the trusted Host's `/data/registry-auth.json`. The existing `COGNIA_REGISTRY_AUTH_FILE` integration uses that copy for registry metadata admission and subsequent pulls. It is not mounted into Agent sandbox children and is removed with the lease data volume. These registry grants do not configure or expand model/API credentials. Update all five trusted template files together when adopting this capability.

## Customize and inject task inputs

Use the existing features once connected:

- **Project runtime environments** select the development image, immutable Agent
  bundle, size class, lifecycle, egress presets and required isolation. The runner
  enables the existing sandbox pool and shares workspaces through a named volume.
- **Project setup / bootstrap Agent** runs the existing deterministic setup and
  bounded repair flow on the execution Host. Put stable dependencies into a
  prebuilt image; use setup for project-specific work.
- **Task workspaces and attachments** use their existing authenticated filesystem
  transfer and ownership rules. An arbitrary desktop absolute path is not a
  remote workspace. Clone or transfer the project through those features first.
- **Instructions and context** travel through the normal Agent session protocol
  and retain its outbound PII checks.
- **Skills** use the existing atomic remote Skill synchronization, including
  content hashes, binary resources and native Agent mirrors.
- **Plugin tools** use the session-scoped renderer tool-host bridge. UI-only
  plugin surfaces stay in Cognia. A plugin's format, permissions and conversion
  fidelity still determine whether a native Agent can receive it; copying an
  arbitrary plugin directory is not installation.

The new remote bridge projects only selected plugin tools and permission/review
metadata. Native Agent filesystem and shell operations remain owned by that
Agent's execution backend. The server rejects attempts to smuggle working
directories, environment variables, model credentials or Cognia builtin tools
through the plugin bridge.

For supported Host-native and Docker sandbox Agent runtimes, selecting a Cognia model creates a
task-scoped gateway lease on the connected Host. It delegates one selected
provider credential and model, rather than publishing the desktop's complete
provider configuration. The child receives a short-lived gateway token; provider
credentials remain in the Host gateway's memory. Leases expire after two minutes
without renewal, and renew every 30 seconds while the task owns them. Account,
provider-settings and Host changes invalidate that authority. Agent exit releases
the lease; device revocation or withdrawal of its execution grant also prevents
renewal and terminates active gateway access. Upstreams must use
public HTTPS: DNS results are checked and pinned for actual connections, proxies
and redirects are disabled, and private/local endpoints are refused. Desktop
loopback model gateways cannot be reused as remote URLs.

Hosted plugin MCP supports Host-native processes and admitted Docker sandbox
Agents, including registration before a session process exists. The sandbox path uses the trusted sidecar's own tool-host listener
and a private `cognia-sandboxd` exec bridge. It does not expose a configurable
general-purpose proxy or the Docker socket to the Agent. Each conversation keeps
its own bearer token, session and permission scope. Bridge renewals run every
20 seconds against a 60-second native lease; the renderer's tool-host lease also
expires if renewal stops. Device revocation, process replacement and admission
changes invalidate the bridge. Update the Host, its sidecar and Agent bundle together; an old
Host or helper without this capability is rejected explicitly.

Docker tasks can use the delegated model gateway and selected plugin tools together.
The Host validates the model ticket and plugin service leases, then attaches fixed
private bridges before releasing the Agent startup barrier. Plugin endpoints keep
the same loopback port inside the container, so later ACP session configuration
and session-scoped Pi/DSH processes use the same endpoint. Pending leases belong to
the paired device and Agent; they cannot specify a forwarding target. Concurrent
sessions keep separate tokens and reference-counted bridge lifetimes.
Runner delegation uses the paired remote Host's Companion task lease. A local
Tauri sandbox uses its own native gateway ticket instead: the Host verifies the
task, token, current account generation and active listener before granting the
bridge. Revoking the ticket, switching accounts or stopping the listener removes
that authority. Local execution does not invent a paired-device identity.

### Agent customization

The Agent editor, inspector and chat Agent manager preserve the command, argument
boundaries (including quoted and empty arguments), environment entries and working
directory. Use paths on the selected Host or inside the selected container. Remote
configuration does not open the desktop's local directory chooser.

When selecting a Cognia model, the task owns provider routing, credentials and
its configuration home. Supported runtime options are retained: for example Pi's
explicit extensions, Skills, prompt templates, system/append-system prompts and
thinking options; Codex's reviewed instruction and reasoning settings; Qwen's
include directories, allowed tools/MCP servers and extensions; and OpenCode's
logging options. Conflicting or unrecognized gateway options produce an explicit
error instead of being silently discarded. Explicit file references must already
exist in the task-visible workspace; this does not transfer desktop files or
enable discovery of ambient Host configuration.

OpenCode inline configuration (`OPENCODE_CONFIG_CONTENT`) also retains named
Agents, instruction references, Skills, slash commands, permissions and snapshot
settings. The bundled OpenCode ACP runtime uses the V1 schema (`agent`, `prompt`,
`permission`, `command`, and `skills.paths`); the separate V2 service uses `agents`,
`system`, `permissions`, `commands`, and a `skills` array. Cognia emits the matching
provider schema and pins custom Agent/command model choices to the selected task
model. For example, set this JSON as `OPENCODE_CONFIG_CONTENT` for OpenCode ACP:

```json
{
  "default_agent": "reviewer",
  "agent": {
    "reviewer": {
      "description": "Review changes",
      "prompt": "Review correctness and explain any risks.",
      "mode": "primary",
      "steps": 12,
      "permission": { "edit": "deny", "bash": "ask" }
    }
  },
  "instructions": ["./AGENTS.md"],
  "skills": { "paths": ["./skills"] }
}
```

The referenced files must exist in the execution workspace. Existing Cognia
permission controls still apply. Unsupported inline fields, arbitrary provider
request overrides, and external `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR` paths are
rejected instead of discarded; use explicit inline settings for this route and
the existing plugin bridge for Cognia plugin tools. The bundled ACP executable
and the V2 service are distinct version/protocol choices, not interchangeable
because they share the OpenCode name. See the pinned upstream
[V1 Agent schema](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/v1/config/agent.ts)
and [V2 configuration schema](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/config.ts).

For a GitHub runner or a selected Docker sandbox, use OpenCode ACP. V2's direct
HTTP service currently requires local Host execution; a selected container is
rejected before connection or discovery because its authenticated HTTP forwarding
path is not implemented. It cannot silently fall back to a Host service.

Locale and output settings (`LC_CTYPE`, `TZ`, `NO_COLOR`, `FORCE_COLOR`) survive
both native and CLI launches, including DSH. Codex ACP also retains `NO_BROWSER`,
`INITIAL_AGENT_MODE` and `APP_SERVER_LOGS`; the latter is a log directory, and
the inner Agent mode does not remove Cognia's outer execution restrictions.

To run an additional CLI or pass an additional non-secret environment key, the
Host operator must opt in. For a runner, bake these policy values into your trusted
Host image while preserving its entrypoint and non-root user:

```dockerfile
ARG COGNIA_HOST_BASE
FROM ${COGNIA_HOST_BASE}
ENV COGNIA_AGENT_COMMAND_ALLOWLIST='["my-agent"]' \
    COGNIA_AGENT_ENV_ALLOWLIST='["AGENT_PERSONA"]'
```

Build with `COGNIA_HOST_BASE` set to your pinned Host image, publish the result,
and use its digest in the runner form. Install the executable in that Host image
for native execution. For sandbox execution, the pinned Agent bundle must also
provide the command in its bundle manifest and compatible libc tree; placing a
binary only in the development image is insufficient. Follow the
[bundle contract](../bundle/README.md), including pinned dependencies and launcher
checks. Select the matching supported Agent protocol in Cognia and use the bare
command name `my-agent`; permission to launch a command does not add a protocol
adapter or Cognia-model adapter for an arbitrary CLI.

Both policy variables are JSON arrays read only from the Host process environment.
Defaults remain restrictive; malformed policy refuses launches. Loader, interpreter,
authentication-scope and Host control variables cannot be enabled this way, nor
can shell/interpreter/package-runner commands. A renderer cannot authorize itself
by including these policy variables in an Agent's environment. Never put secrets
in image layers or ordinary Agent configuration; use the existing credential and
environment-secret mechanisms.

Each array is limited to 8 KiB, 64 unique names and 128 ASCII characters per name.
Names are exact and case-sensitive. An unset variable or `[]` keeps the defaults;
an empty string, duplicate entry or invalid/reserved name fails closed. Extra
commands cannot use paths or `.exe`, `.cmd` or `.bat` suffixes.

### Current capability matrix

“Host-native” means an Agent CLI inside the temporary Cognia Host container.
“Docker sandbox” means a separate execution container managed by that Host. Both
run on the GitHub-hosted VM. These are implementation boundaries, not claims of
successful live GitHub deployment.

| Capability                                | Host-native                                                                                             | Docker sandbox                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Terminal, files, Git and remote workspace | Existing Companion protocol                                                                             | Host-managed workspace and existing container mounts                                                                           |
| Agent runtime                             | CLI installed in the Host image; use `runtime-full` when needed                                         | Pinned Agent bundle and development image, with compatibility admission                                                        |
| Custom toolchains and system dependencies | Custom Host image preserving its startup contract                                                       | Custom development image selected in project runtime settings                                                                  |
| Project setup and bootstrap repair        | Existing flow on the execution Host                                                                     | Existing isolation, egress and admission rules                                                                                 |
| Instructions, context and attachments     | Existing session and workspace transfer paths                                                           | Same paths, limited to the container-visible workspace                                                                         |
| Skills                                    | Atomic remote synchronization and native Agent mirrors                                                  | Requires the runtime's synchronization, mounts and Agent support; Host synchronization alone is insufficient                   |
| Desktop plugin tools over hosted MCP      | Session-scoped tool-host bridge                                                                         | Prelaunch registration and authenticated exec bridges for persistent or ephemeral Agents; requires the updated Host and bundle |
| Native file and shell tools               | Host execution backend                                                                                  | Container execution backend, outside the plugin bridge                                                                         |
| UI-only plugins                           | UI stays in Cognia                                                                                      | UI stays in Cognia                                                                                                             |
| Model access and credentials              | Selected Cognia model through a task-scoped public-HTTPS gateway lease, or supported Host configuration | Same delegated lease through a fixed private bridge, with fresh admission and a startup barrier                                |
| Required container isolation              | Native process mode does not provide this guarantee                                                     | Existing mandatory-isolation controls                                                                                          |
| Private registry access                   | Optional Actions secret configures the trusted Host                                                     | Host performs pulls/admission; credential file is not mounted into Agent children                                              |
| Workspace or image cache across jobs      | Not guaranteed; lease volumes are temporary                                                             | Not guaranteed; child containers and owned volumes are cleaned up                                                              |

Custom command/environment permissions, supported protocol adapters and bundle
availability are separate requirements. Provisioning does not make every
Agent/plugin combination portable.

## Startup and lifecycle

The UI separates dispatch, queue, startup, ready, stopping and terminal states.
GitHub queue time is external and has no latency guarantee. Bootstrap pulls the
three digest-pinned images concurrently and reports each image pull duration plus overall Host readiness time in the Actions log. Prebuilding small images removes per-task dependency installation; an image
pull can still be a cold network transfer on a new GitHub-hosted VM. No warm-pool
or cross-job image-cache performance is promised.

The lease budget starts when bootstrap starts; the workflow's 350-minute timeout
is the outer bound. UI expiry is an estimate from GitHub's run start and can be
slightly earlier than bootstrap's deadline. The runner never extends the lease
automatically. Save or export work before release; runner volumes are temporary.

The local lease ledger is written before dispatch. A lost response is retained as
an uncertain lease and recovered by its unique workflow run name; the desktop
does not blindly dispatch another job. Recovery verifies the repository, workflow,
commit, original actor and first run attempt. Switching the local GitHub account
cannot cancel another account's recorded lease. **Stop** stays pending until
GitHub confirms workflow completion. Failed cancellation retains its record for
retry. Terminal failure and confirmed stop both release the active Host selection.

Pairing invitations expire quickly and are renewed during the lease. The artifact
contains only P-256/HKDF-SHA256/AES-256-GCM encrypted data bound to the lease ID and
workflow run ID. The recipient private key stays in the local lease ledger;
plaintext invitations never enter Actions logs or artifacts. Each Host creates
its own vault master key inside its private data volume. Cleanup stops the Host,
removes child containers and owned volumes, and deletes the encrypted artifact;
GitHub destroys the hosted VM at job completion.

This is a single-user temporary Host. The trusted Host owns the Docker daemon
connection; Agent sandbox containers do not receive that connection. Use the
existing mandatory-isolation controls when a task requires container isolation.
Task configuration homes use scoped ownership and protected account/device
bindings. Persistent tasks sharing a container and Unix user remain in the same
workspace trust boundary; private task directories do not isolate mutually
untrusted sibling processes. Retained task deletion validates ownership and
refuses active task state rather than reporting success after only removing a
Host-side file.
Ephemeral containers lose their Agent configuration home and native session
history when removed. Use a persistent project runtime when native resume state
must survive process exits; export work before the runner lease ends in either
mode.

## Verification

Local checks cover provider state transitions, account/run provenance, uncertain
outcomes, cancellation failure, corrupt-ledger recovery, artifact limits and
Node-to-Rust encryption interoperability. Bootstrap tests check image/input
validation, relay-only pairing, secret exclusion and scoped cleanup. UI and
transport tests exercise host routing, management and recovery.

Focused gateway tests cover task/device/account ownership, revocation and
credential isolation. Bridge tests use real local TCP sockets and the helper
protocol to exercise forwarding, expiry and cleanup; these are not Docker or
GitHub end-to-end tests. UI lifecycle verification uses synthetic native IPC.
Customization tests cover argument round trips, preserved runtime settings,
operator policy and rejected routing overrides. Sandbox helper tests cover
readiness, protected bindings, symlink/hardlink refusal and retained-state cleanup.

Real GitHub scheduling, image availability, relay pairing and end-to-end Agent
execution require an installed template, actual image digests and an authorized
provisioner repository. Passing the local tests does not establish those live
deployment properties. Verify Host-native and required Docker sandbox/plugin
combinations separately in the deployed environment.

Sources: [GitHub JavaScript action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax),
[@actions/artifact](https://github.com/actions/toolkit/tree/main/packages/artifact),
[GitHub Actions limits](https://docs.github.com/en/actions/reference/limits).
