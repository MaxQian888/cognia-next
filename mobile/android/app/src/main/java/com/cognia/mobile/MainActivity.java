package com.cognia.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Patterns;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Cold start: rewrite before the Bridge captures the launch intent so
        // App.getLaunchUrl() / the boot-time appUrlOpen replay see the deeplink.
        rewriteShareIntent(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // Warm start (launchMode=singleTask): rewrite before the Bridge fans the
        // intent out to plugins so the App plugin fires appUrlOpen with our URI.
        rewriteShareIntent(intent);
        super.onNewIntent(intent);
    }

    /**
     * Convert an ACTION_SEND share-sheet intent into the {@code cognia://share}
     * deep link the web layer already routes (lib/capacitor/deeplink.ts, host
     * "share"). Capacitor's App plugin only surfaces intents that carry a data
     * URI — ACTION_SEND keeps its payload in extras — so without this rewrite a
     * share from another app opens Cognia with the payload silently dropped.
     */
    private void rewriteShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return;
        }
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) {
            return;
        }

        Uri.Builder deeplink = new Uri.Builder().scheme("cognia").authority("share");
        String trimmed = text.trim();
        if (Patterns.WEB_URL.matcher(trimmed).matches()) {
            deeplink.appendQueryParameter("url", trimmed);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (subject != null && !subject.trim().isEmpty()) {
                deeplink.appendQueryParameter("text", subject.trim());
            }
        } else {
            deeplink.appendQueryParameter("text", text);
        }

        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(deeplink.build());
    }
}
