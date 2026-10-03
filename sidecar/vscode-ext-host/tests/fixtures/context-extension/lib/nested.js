"use strict"
// Required from the main bundle: its own `require("vscode")` must still be
// attributed to the extension, which is what the old tag-based resolver lost.
module.exports = { version: () => require("vscode").version }
