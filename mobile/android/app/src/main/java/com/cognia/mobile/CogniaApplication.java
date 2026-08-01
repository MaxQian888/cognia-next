package com.cognia.mobile;

import android.app.Application;
import android.content.Context;

import org.acra.ACRA;
import org.acra.ReportField;
import org.acra.config.CoreConfigurationBuilder;
import org.acra.data.StringFormat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CogniaApplication extends Application {
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        CoreConfigurationBuilder config = new CoreConfigurationBuilder()
            .withBuildConfigClass(BuildConfig.class)
            .withReportFormat(StringFormat.JSON)
            .withReportContent(
                ReportField.REPORT_ID,
                ReportField.APP_VERSION_CODE,
                ReportField.APP_VERSION_NAME,
                ReportField.PACKAGE_NAME,
                ReportField.ANDROID_VERSION,
                ReportField.BRAND,
                ReportField.PHONE_MODEL,
                ReportField.PRODUCT,
                ReportField.STACK_TRACE,
                ReportField.USER_CRASH_DATE,
                ReportField.IS_SILENT,
                ReportField.AVAILABLE_MEM_SIZE,
                ReportField.TOTAL_MEM_SIZE
            );
        ACRA.init(this, config);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ExecutorService collector = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "cognia-exit-diagnostics");
            thread.setDaemon(true);
            return thread;
        });
        collector.execute(() -> new CogniaCrashStore(this).collectApplicationExitInfo(this));
        collector.shutdown();
    }
}
