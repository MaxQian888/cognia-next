package com.cognia.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.huawei.agconnect.config.AGConnectServicesConfig;
import com.huawei.hms.api.HuaweiApiAvailability;
import com.huawei.hms.aaid.HmsInstanceId;
import com.huawei.hms.push.HmsMessaging;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** App-local HMS adapter with the same event contract as Capacitor PushNotifications. */
@CapacitorPlugin(
    name = "CogniaHuaweiPush",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "receive")
)
public class CogniaHuaweiPushPlugin extends Plugin {
    static final String PREFERENCES = "cognia-huawei-push";
    static final String CHANNEL_ID = "cognia-default";
    private static volatile WeakReference<CogniaHuaweiPushPlugin> instance = new WeakReference<>(null);
    private final ExecutorService tokenExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean foreground;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        ensureChannel(getContext());
        // The bridge exists before JS listeners do. Retain cold-start taps and
        // the latest token so listeners installed during bootstrap receive them.
        handleOnNewIntent(getActivity().getIntent());
        if (isEnabled(getContext())) {
            String token = getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString("token", null);
            if (token != null) emitToken(token);
        }
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, context.getString(R.string.app_name), NotificationManager.IMPORTANCE_HIGH
            ));
        }
    }

    static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean("enabled", false);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        boolean configured = BuildConfig.HUAWEI_PUSH_CONFIGURED && !appId().isEmpty();
        // Probe only; never ask HMS to display an install/update dialog.
        int status = HuaweiApiAvailability.getInstance().isHuaweiMobileServicesAvailable(getContext());
        JSObject result = new JSObject();
        result.put("configured", configured);
        result.put("available", configured && status == 0);
        result.put("status", status);
        call.resolve(result);
    }

    private String appId() {
        if (!BuildConfig.HUAWEI_PUSH_CONFIGURED) return "";
        String value = AGConnectServicesConfig.fromContext(getContext()).getString("client/app_id");
        return value == null ? "" : value;
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject result = new JSObject();
        String permission = Build.VERSION.SDK_INT >= 33 ? getPermissionState("receive").toString() : "granted";
        if ("granted".equals(permission) && !NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            permission = "denied";
        }
        result.put("receive", permission);
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("receive") == PermissionState.GRANTED) {
            checkPermissions(call);
        } else {
            requestPermissionForAlias("receive", call, "permissionsCallback");
        }
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        checkPermissions(call);
    }

    @PluginMethod
    public void register(PluginCall call) {
        String appId = appId();
        if (appId.isEmpty()) {
            call.reject("Huawei push is not configured for this build.", "PUSH_NOT_CONFIGURED");
            return;
        }
        if (HuaweiApiAvailability.getInstance().isHuaweiMobileServicesAvailable(getContext()) != 0) {
            call.reject("Huawei Mobile Services are unavailable.", "PUSH_UNAVAILABLE");
            return;
        }
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            call.reject("Notification permission is not granted.", "PUSH_PERMISSION_DENIED");
            return;
        }
        getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean("enabled", true).apply();
        tokenExecutor.execute(() -> {
            try {
                HmsMessaging.getInstance(getContext()).setAutoInitEnabled(true);
                String token = HmsInstanceId.getInstance(getContext()).getToken(appId, "HCM");
                // Older EMUI returns an empty value and delivers onNewToken later.
                if (token != null && !token.isEmpty()) receiveToken(getContext(), token);
                call.resolve();
            } catch (Exception error) {
                getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                    .putBoolean("enabled", false).remove("token").apply();
                try {
                    HmsMessaging.getInstance(getContext()).setAutoInitEnabled(false);
                } catch (RuntimeException unavailableSdk) {
                    // Still reject the original registration instead of crashing
                    // the process if the SDK itself failed during initialization.
                }
                emitError("Huawei push registration failed (" + error.getClass().getSimpleName() + ").");
                call.reject("Huawei push registration failed.", "PUSH_REGISTRATION_FAILED");
            }
        });
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putBoolean("enabled", false).remove("token").apply();
        tokenExecutor.execute(() -> {
            try {
                HmsMessaging.getInstance(getContext()).setAutoInitEnabled(false);
                String appId = appId();
                if (!appId.isEmpty()) HmsInstanceId.getInstance(getContext()).deleteToken(appId, "HCM");
                call.resolve();
            } catch (Exception error) {
                call.reject("Huawei push token removal failed.", "PUSH_UNREGISTER_FAILED");
            }
        });
    }

    static void receiveToken(Context context, String token) {
        if (!isEnabled(context) || token == null || token.isEmpty()) return;
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString("token", token).apply();
        CogniaHuaweiPushPlugin plugin = instance.get();
        if (plugin != null) plugin.emitToken(token);
    }

    private void emitToken(String token) {
        JSObject event = new JSObject();
        event.put("value", token);
        notifyListeners("registration", event, true);
    }

    static void receiveError(String error) {
        CogniaHuaweiPushPlugin plugin = instance.get();
        if (plugin != null) plugin.emitError(error);
    }

    private void emitError(String error) {
        JSObject event = new JSObject();
        event.put("error", error);
        notifyListeners("registrationError", event, true);
    }

    static boolean receiveMessage(JSObject notification) {
        CogniaHuaweiPushPlugin plugin = instance.get();
        if (plugin == null || !plugin.foreground) return false;
        plugin.notifyListeners("pushNotificationReceived", notification, true);
        return true;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        JSObject notification = CogniaHuaweiPushPayload.fromIntent(intent);
        if (notification == null) return;
        // Consume only our notification intent; leave OAuth/share handling alone.
        intent.putExtra("cogniaHuaweiPushHandled", true);
        JSObject event = new JSObject();
        event.put("actionId", "tap");
        event.put("notification", notification);
        notifyListeners("pushNotificationActionPerformed", event, true);
    }

    @Override
    protected void handleOnResume() { foreground = true; }

    @Override
    protected void handleOnPause() { foreground = false; }

    @Override
    protected void handleOnDestroy() {
        if (instance.get() == this) instance.clear();
        tokenExecutor.shutdown();
    }
}
