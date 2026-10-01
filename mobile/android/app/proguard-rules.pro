# Capacitor and ACRA supply their plugin/reflection consumer rules.
# ACRA additionally reads this application's BuildConfig fields by reflection.
-keepclassmembers class com.cognia.mobile.BuildConfig {
    public static <fields>;
}

# JmDNS (via capacitor-zeroconf) uses SLF4J 1.7 without a logging backend.
# LoggerFactory catches this optional binder's absence and uses its NOP logger.
-dontwarn org.slf4j.impl.StaticLoggerBinder
