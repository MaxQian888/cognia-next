import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path) => readFileSync(new URL(`../android/${path}`, import.meta.url), "utf8")
const plugin = read("app/src/main/java/com/cognia/mobile/CogniaHuaweiPushPlugin.java")
const service = read("app/src/main/java/com/cognia/mobile/CogniaHuaweiMessagingService.java")
const manifest = read("app/src/main/AndroidManifest.xml")

test("HMS is registered with Capacitor and receives SDK messages without exporting the service", () => {
  assert.match(read("app/src/main/java/com/cognia/mobile/MainActivity.java"), /registerPlugin\(CogniaHuaweiPushPlugin.class\)/)
  assert.match(manifest, /android:name="\.CogniaHuaweiMessagingService"\s+android:exported="false"/)
  assert.match(manifest, /com.huawei.push.action.MESSAGING_EVENT/)
  assert.match(manifest, /com.cognia.mobile.HUAWEI_PUSH/)
  assert.match(manifest, /push_kit_auto_init_enabled" android:value="false"/)
})

test("ordinary Android builds remain valid without AppGallery configuration", () => {
  const gradle = read("app/build.gradle")
  assert.match(gradle, /huaweiPushConfigured = file\('agconnect-services.json'\).isFile\(\)/)
  assert.match(gradle, /if \(huaweiPushConfigured\) \{\s+apply plugin: 'com.huawei.agconnect'/)
  assert.match(gradle, /HUAWEI_PUSH_CONFIGURED.*huaweiPushConfigured.toString\(\)/)
  assert.match(plugin, /if \(!BuildConfig.HUAWEI_PUSH_CONFIGURED\) return ""/)
  assert.match(plugin, /PUSH_NOT_CONFIGURED/)
  assert.doesNotMatch(plugin, /resolveError|makeHuaweiMobileServicesAvailable|getErrPendingIntent/)
})

test("cold start taps, token refresh and pre-listener events survive bridge bootstrap", () => {
  assert.match(plugin, /handleOnNewIntent\(getActivity\(\).getIntent\(\)\)/)
  assert.match(plugin, /notifyListeners\("pushNotificationActionPerformed", event, true\)/)
  assert.match(plugin, /notifyListeners\("registration", event, true\)/)
  assert.match(service, /onNewToken\(String token\)[\s\S]*receiveToken\(this, token\)/)
  assert.match(plugin, /getToken\(appId, "HCM"\)/)
  assert.match(plugin, /deleteToken\(appId, "HCM"\)/)
})

test("device push tokens are excluded from both cloud restore and device transfer", () => {
  assert.match(read("app/src/main/res/xml/backup_rules.xml"), /path="cognia-huawei-push.xml"/)
  assert.equal(read("app/src/main/res/xml/data_extraction_rules.xml").match(/path="cognia-huawei-push.xml"/g)?.length, 2)
})

test("background data fallback uses immutable native notification taps and checks permission", () => {
  assert.match(service, /areNotificationsEnabled\(\)/)
  assert.match(service, /if \(hasNativeNotification \|\|/)
  assert.match(service, /!TextUtils.isEmpty\(remote.getTitle\(\)\) \|\| !TextUtils.isEmpty\(remote.getBody\(\)\)/)
  assert.match(service, /PendingIntent.FLAG_IMMUTABLE/)
  assert.match(service, /setContentIntent\(tap\)/)
  assert.match(plugin, /requestPermissionForAlias\("receive", call, "permissionsCallback"\)/)
})
