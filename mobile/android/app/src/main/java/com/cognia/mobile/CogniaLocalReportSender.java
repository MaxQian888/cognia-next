package com.cognia.mobile;

import android.content.Context;

import org.acra.data.CrashReportData;
import org.acra.sender.ReportSender;
import org.acra.sender.ReportSenderException;

final class CogniaLocalReportSender implements ReportSender {
    @Override
    public void send(Context context, CrashReportData report) throws ReportSenderException {
        try {
            new CogniaCrashStore(context).persist("android-acra", report.toJSON());
        } catch (Exception exception) {
            throw new ReportSenderException("Unable to persist redacted crash report", exception);
        }
    }
}
