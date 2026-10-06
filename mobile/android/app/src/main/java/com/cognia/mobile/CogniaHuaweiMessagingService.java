package com.cognia.mobile;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.text.TextUtils;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.huawei.hms.push.HmsMessageService;
import com.huawei.hms.push.RemoteMessage;

public class CogniaHuaweiMessagingService extends HmsMessageService {
    @Override
    public void onNewToken(String token) {
        CogniaHuaweiPushPlugin.receiveToken(this, token);
    }

    @Override
    public void onTokenError(Exception error) {
        CogniaHuaweiPushPlugin.receiveError("Huawei push token refresh failed.");
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        if (!CogniaHuaweiPushPlugin.isEnabled(this)) return;
        JSObject data = CogniaHuaweiPushPayload.parseData(message.getData());
        RemoteMessage.Notification remote = message.getNotification();
        JSObject notification = CogniaHuaweiPushPayload.notification(
            message.getMessageId(), remote == null ? null : remote.getTitle(), remote == null ? null : remote.getBody(), data
        );
        if (CogniaHuaweiPushPlugin.receiveMessage(notification)) return;
        // Normal HMS notification messages are rendered by the system even if
        // the process is dead. Render data-only messages if delivered in background.
        // HMS returns an empty Notification object even for data-only messages.
        boolean hasNativeNotification = remote != null
            && (!TextUtils.isEmpty(remote.getTitle()) || !TextUtils.isEmpty(remote.getBody()));
        if (hasNativeNotification || !NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) return;
        String title = notification.optString("title", "");
        String body = notification.optString("body", "");
        if (title.isEmpty() && body.isEmpty()) return;
        CogniaHuaweiPushPlugin.ensureChannel(this);
        int id = message.getMessageId() == null || message.getMessageId().isEmpty()
            ? (int) System.currentTimeMillis() : message.getMessageId().hashCode();
        Intent intent = new Intent(this, MainActivity.class).setAction(CogniaHuaweiPushPayload.ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("data", data.toString()).putExtra("msgId", message.getMessageId());
        PendingIntent tap = PendingIntent.getActivity(this, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CogniaHuaweiPushPlugin.CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setContentIntent(tap).setAutoCancel(true);
        try {
            NotificationManagerCompat.from(this).notify(id, builder.build());
        } catch (SecurityException permissionRevoked) {
            // Notification permission may be revoked between the check and post.
        }
    }
}
