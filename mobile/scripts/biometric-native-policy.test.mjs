import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const nativeRoot = new URL(
  "../node_modules/@capgo/capacitor-native-biometric/android/src/main/java/ee/forgr/biometric/",
  import.meta.url
)
const source = (file) => readFileSync(new URL(file, nativeRoot), "utf8")

// These contracts cover the installed dependency, so upgrading or losing the
// pnpm patch cannot silently weaken account-unlock storage. Device-level
// Keystore behavior still needs native acceptance testing.
test("CurrentSet key generation never retries with enrollment invalidation disabled", () => {
  for (const [file, start, end, operation] of [
    [
      "AsymmetricSecureDataHelper.java",
      "private static KeyStore.PrivateKeyEntry getOrCreateKeyPair",
      "private static KeyStore.PrivateKeyEntry getExistingPrivateKeyEntry",
      "generateKeyPair",
    ],
    [
      "AuthActivity.java",
      "private SecretKey getOrCreateCredentialKey(String server, int accessControl, int authValidityDuration)",
      "private boolean",
      "buildCredentialKey",
    ],
  ]) {
    const text = source(file)
    const begin = text.indexOf(start)
    assert.ok(begin >= 0, `${file}: key creation method must still exist`)
    const finish = text.indexOf(end, begin + start.length)
    assert.ok(finish > begin, `${file}: method boundary must still exist`)
    const method = text.slice(begin, finish)
    assert.match(method, /effectiveAccessControl == 1/)
    assert.match(method, new RegExp(`${operation}\\(alias, invalidatedByEnrollment`))
    assert.doesNotMatch(method, new RegExp(`${operation}\\(alias, false`))
    assert.match(
      method,
      /catch \(ProviderException e\) \{[\s\S]*throw new GeneralSecurityException/
    )
  }
})

test("protected data reads allow five failed matches before the app ends the prompt", () => {
  const text = source("NativeBiometric.java")
  const begin = text.indexOf("public void getSecureData(final PluginCall call)")
  const finish = text.indexOf("public void deleteData", begin)
  assert.ok(begin >= 0 && finish > begin)
  assert.match(text.slice(begin, finish), /intent\.putExtra\("maxAttempts", 5\)/)
  assert.match(
    source("AuthActivity.java"),
    /maxAttempts = Math\.max\(1, Math\.min\(5, rawMaxAttempts\)\)/
  )
})
