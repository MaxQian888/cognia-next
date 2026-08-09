# Integration compatibility bundle

`github-delivery-2.0.0.zip` is the one-major-version compatibility installer
for migrating the former built-in GitHub Delivery plugin to the schema-v4
Integration runtime.

- Publisher key fingerprint:
  `84d0a963598e45454ae1eddb431cd4f93fd25616cf12c28c9f47f31ef98005c8`
- Bundle SHA-256:
  `1f43c59f80aaa8a6a4ae31decf075d28300f7b7da00c698a658e31894a3d957a`
- Signature SHA-256:
  `c8575935df9a656462bb0e585245f45dd2c7a33afae2c787e3739c5409e1e80f`

Verify it with:

```bash
cognia plugin verify github-delivery-2.0.0.zip
```

`github-delivery-3.0.0.zip` is generated from the maintained source at
`plugins/github-delivery/src/index.ts`. Regenerate and verify source parity with:

```bash
pnpm exec tsx scripts/plugin/build-github-delivery.ts
pnpm exec tsx scripts/plugin/build-github-delivery.ts --check
```

The release pipeline signs the generated v3 ZIP with the same official key;
the private signing key remains outside the repository. The signed v2 bundle
and detached signature remain available for one-major rollback compatibility.

The private development publisher key is not stored in this repository.
