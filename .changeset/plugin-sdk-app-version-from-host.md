---
"cognia-next": patch
---

The plugin SDK's `APP_VERSION` (`@cognia/plugin-sdk/api/host-environment`) is now supplied by the host's SDK loader instead of being read from the host's `package.json` at import. Plugins running in Cognia see the same version as before; code that imports the SDK outside a Cognia host, such as a plugin's unit tests, sees `"0.0.0"`.
