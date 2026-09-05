---
title: "0171: The CLI speaks the protocol, not a copy of it"
description: "cognia-agent reaches the Host command plane through a generated index of the frozen protocol contract, over the two authority modes the dispatcher actually admits, refusing locally whatever the Host would refuse."
---

# ADR 0171: The CLI speaks the protocol, not a copy of it

**Status:** Accepted
**Date:** 2026-09-06
**Amends:** ADR-0013 (command manifest), ADR-0078 (CLI to app bridge)
**Related:** ADR-0059 (headless brain), ADR-0143 (device console), ADR-0153 (the host obtains the confirmation)

## Context

`cognia-agent` had 23 hand-written commands. Two of them called a Host: `lark`
with its own `fetch` and poll loop, and `provider` behind the only real
transport abstraction the CLI had.

Meanwhile the Host publishes a fully specified command plane. The generated
Companion specs carry 656 concrete `/internal/_rpc/{name}` operations and 527
concrete `/api/_rpc/{name}` operations, and `pnpm companion-api:gen` fails if
any RPC would fall back to a generic request shape. Every command's fields,
types, enums, risk, approval and idempotency requirement are machine-readable
and drift-gated.

So reaching a command from a terminal meant writing a command, against a
contract that already described it. ADR-0013 chose a hand-written allowlist
over codegen and said to revisit past roughly 150 commands. The surface is now
1318 descriptors and 656 remotely dispatchable commands.

## The constraint that shaped the design

`authorize_transport` and `authorize_approval` in
`src-tauri/src/companion_api/remote_execution.rs` admit exactly two authority
modes, and there is no third:

```rust
let allowed = if transport == Internal { service_principal }
              else { !service_principal
                     && target ∈ {Execution, HostAdmin}
                     && descriptor.transports.contains(transport) };
```

```rust
if principal.scope == "service" && transport == Internal { return Ok(()); }
```

| Mode | Route | Reach | Capability check | Approval check |
| --- | --- | --- | --- | --- |
| service + Internal | `POST /internal/_rpc/{name}` | all 656 | bypassed | bypassed |
| device + Http | `POST /api/_rpc/{name}` | 527 | per-device grant | admin lease or signed policy |

A loopback service principal is deliberately the policy authority for the Brain
plane. A device principal is deliberately not.

## Decision

1. **Generate the CLI's command index from the protocol contract.**
   `scripts/build/gen-cli-api-index.mjs` joins
   `protocol/companion-commands.json` with both OpenAPI specs into
   `cli/src/api/generated/command-index.ts`. `pnpm cli:api:check` fails on
   drift, the way `companion-api:check` does for its own sources. Adding a
   command to the Host adds it to the CLI.

2. **Two surfaces over one index.** `api call/list/groups/describe/schema/request`
   is the floor and guarantees coverage. Derived `<group> <action>` commands
   are a projection of the wire names, so `plugin list` is
   `api call plugin_list`. The 23 hand-written commands keep their names
   unconditionally, four protocol groups collide with one, and a test pins that
   list so a new Host command cannot quietly change what a familiar verb does.

3. **Two wires, and the CLI never pretends there is a third.** A command is
   refused locally when the selected wire does not carry it, because
   `authorize_transport` would refuse it anyway. On the device wire an
   `interactive` command without a lease and a `signed-policy` command without a
   policy are refused with the remedy attached rather than sent to earn a 428.

4. **Refuse before the wire whenever the contract already says no.** Every
   companion request schema is `additionalProperties: false` and enforced at
   runtime, so an unknown field is a guaranteed 422. Unknown fields, missing
   required fields, alias requirement groups and out-of-range enums are all
   checked against the index first, and the UUID idempotency key the Host
   demands for 1090 commands is minted rather than left to the caller.

5. **Hosts are saved records, not environment variables.**
   `~/.cognia/hosts.json` at 0600 holds the endpoint, the wire, the credential,
   and the TLS SPKI pin. Layers merge per key: flag, environment, project file,
   user file. `host show` prints the winning source for every value.

6. **The CLI bridge keeps brokering, not dispatching.** ADR-0078 gave the
   bridge 18 routes and a same-user loopback trust model. A generic
   `/api/dev/_rpc/{name}` there would have to run as a service principal on the
   Internal transport, which would raise the dev-token bridge from its
   8-command low-risk-read allowlist to all 656 commands with every approval
   bypassed, on the one Host where a human is present to answer them. The
   desktop is reached by pairing with its Companion API instead, which is the
   same flow a phone uses.

## Consequences

- The CLI's coverage is the Host's coverage, and stays there by gate rather
  than by review.
- A failure names a next action. Every refusal carries `Fix` and `Inspect`
  lines, because the primary reader of a failed command here is an agent.
- An enrolled CLI is a device the owner can see, grant, suspend and revoke in
  the Device Console. It gains no authority the device wire does not already
  grant a phone.
- The index is compiled in, around 270 KB, so `api list`, `describe` and
  `--help` all answer offline and a malformed call never reaches a socket.
- ADR-0013's "hand-written allowlist, no codegen" still governs what the Host
  exposes. This ADR governs only how a client consumes what is exposed, and the
  allowlist remains the security perimeter.
- The desktop CLI bridge gains nothing from this work. If skipping a pairing
  code on the local machine is ever worth a route, it must broker a credential
  the way `/api/dev/acp/ticket` does, never dispatch a command.

## Alternatives considered

- **Hand-write a resource command per subsystem.** Rejected: it cannot be
  complete, and every new Host command becomes a CLI change.
- **A generic dispatch route on the CLI bridge.** Rejected on the authority
  analysis above. It is a privilege escalation wearing a convenience.
- **Read the OpenAPI specs at runtime.** Rejected: 5.5 MB of YAML to parse per
  invocation, and the CLI ships as one bundled file.
- **Let the Host validate everything.** Rejected: the contract is already on
  the client, and a local refusal that names the field beats a 422 that does
  not.
