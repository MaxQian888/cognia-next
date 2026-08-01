# Cognia Ops Controller production deployment

This Compose stack runs PostgreSQL, the controller, and a Caddy TLS boundary on any Linux host.
Caddy requests and validates the enrolled client certificate, removes all inbound trust headers, and
injects the certificate SHA-256 fingerprint plus a controller-only proxy token. The Axum service
rejects agent WebSockets that bypass this boundary.

Create `COGNIA_OPS_SECRET_ROOT` with mode `0700` and these files before starting:

- `database-url`: PostgreSQL URL matching the configured database password.
- `agent-ca.crt.pem` and `agent-ca.key.pem`: the enrollment CA certificate and private key.
- `operation-signing-key`: base64-encoded 32-byte Ed25519 seed.
- `agent-proxy-token`: at least 32 random bytes, without a trailing newline.

Set digest-pinned `POSTGRES_IMAGE`, `COGNIA_OPS_CONTROLLER_IMAGE`, and `CADDY_IMAGE`, configure the
OIDC issuer/audience and public domain, then run:

```sh
docker compose -f deploy/controller/compose.yaml up -d --wait
```

Only Caddy publishes ports. Never publish port 8080 or place another proxy between Caddy and the
controller unless it preserves the same header-stripping and private proxy-token contract.
