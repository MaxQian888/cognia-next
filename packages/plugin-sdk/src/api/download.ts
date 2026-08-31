/**
 * Plugin SDK — browser download helper.
 *
 * Published face for `../runtime/download`. Anything that hands the user a
 * generated file (an audit export, a pack, a report) needs the same
 * object-URL-and-revoke dance; this is the one implementation of it.
 */

export { downloadBlob } from "../runtime/download"
