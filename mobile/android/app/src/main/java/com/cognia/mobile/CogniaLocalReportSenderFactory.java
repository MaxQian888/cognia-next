package com.cognia.mobile;

import android.content.Context;

import org.acra.config.CoreConfiguration;
import org.acra.sender.ReportSender;
import org.acra.sender.ReportSenderFactory;

public final class CogniaLocalReportSenderFactory implements ReportSenderFactory {
    @Override
    public ReportSender create(Context context, CoreConfiguration config) {
        return new CogniaLocalReportSender();
    }
}
