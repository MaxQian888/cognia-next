# Cognia VS Code-extension plugin template

This starter is emitted by:

```bash
cognia plugin new my-vscode-plugin --kind vscode
```

The host loads `extension/out/extension.js` from `plugin.json`'s `vscodeMain` field and runs it through the Cognia VS Code sidecar. The sample exports `activate` and `deactivate`, registers one VS Code command, and ships `package.json` through `bundle_include`.

## Validate and package

```bash
node --check extension/out/extension.js
cognia plugin lint
cognia plugin build
```

`cognia plugin build` is build-free for VS Code-extension plugins: it validates `plugin.json`, then packages `plugin.json`, the declared `vscodeMain`, optional `styles.css`, and any `bundle_include[]` files into `target/cognia/<id>-<version>.zip`.
