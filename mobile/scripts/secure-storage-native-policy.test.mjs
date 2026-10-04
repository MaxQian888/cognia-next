import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const nativeRoot = new URL(
  "../node_modules/capacitor-secure-storage-plugin/android/src/main/java/com/whitestein/securestorage/",
  import.meta.url
)
const source = (file) => readFileSync(new URL(file, nativeRoot), "utf8")

// Pin the installed native patch as well as the checked-in backup policy.
// These checks do not read or mutate the device's actual credential store.
test("secure storage cannot downgrade Keystore failures to Base64 preferences", () => {
  const helper = source("PasswordStorageHelper.java")
  assert.doesNotMatch(helper, /PasswordStorageHelper_SDK16/)
  assert.match(helper, /if \(!passwordStorage\.init\(context\)\)\s*\{\s*throw new IllegalStateException/)
  assert.match(helper, /if \(!preferences\.getAll\(\)\.isEmpty\(\)\)\s*\{\s*throw new IllegalStateException/)
})

test("Keystore write, read and commit failures are observable to JavaScript", () => {
  const helper = source("PasswordStorageHelper.java")
  assert.doesNotMatch(helper, /e\.printStackTrace\(\)/)
  assert.doesNotMatch(helper, /if \(ks\.getCertificate\(alias\) == null\) return/)
  assert.doesNotMatch(helper, /(?<!if \(!)editor\.commit\(\);/)
  assert.match(helper, /throw new IllegalStateException\("Secure storage write failed", e\)/)
  assert.match(helper, /throw new IllegalStateException\("Secure storage read failed", e\)/)
  const plugin = source("SecureStoragePluginPlugin.java")
  assert.match(plugin, /private Exception initializationError/)
  assert.match(plugin, /throw new IllegalStateException\("Secure storage is unavailable", initializationError\)/)
  assert.match(plugin, /requireStorage\(\)\.setData/)
})

test("existing ciphertext and Keystore identity keep their established format", () => {
  const helper = source("PasswordStorageHelper.java")
  assert.match(helper, /PREFERENCES_FILE = "cap_sec"/)
  assert.match(helper, /alias = context\.getPackageName\(\) \+ "_cap_sec"/)
  assert.match(helper, /RSA\/ECB\/PKCS1Padding/)
  assert.match(helper, /KEY_LENGTH = 2048/)
  assert.doesNotMatch(helper, /deleteEntry\(/)
})

test("device-bound encrypted preferences are excluded from all Android backup modes", () => {
  const rules = readFileSync(new URL("../android/app/src/main/res/xml/backup_rules.xml", import.meta.url), "utf8")
  const extraction = readFileSync(new URL("../android/app/src/main/res/xml/data_extraction_rules.xml", import.meta.url), "utf8")
  const exclusion = /<exclude domain="sharedpref" path="cap_sec\.xml"\s*\/>/
  assert.match(rules, exclusion)
  for (const section of ["cloud-backup", "device-transfer"]) {
    const contents = extraction.match(new RegExp(`<${section}[^>]*>([\\s\\S]*?)<\\/${section}>`))?.[1]
    assert.ok(contents, `${section} rules exist`)
    assert.match(contents, exclusion)
  }
})
