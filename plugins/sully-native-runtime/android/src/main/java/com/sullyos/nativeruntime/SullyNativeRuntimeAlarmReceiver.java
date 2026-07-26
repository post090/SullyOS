package com.sullyos.nativeruntime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Fires when a scheduled exact alarm goes off. Alarms are used for durable "to-the-minute"
 * timers (role events / VR / world) so the process does NOT need to keep a worker thread
 * sleeping (and survives Doze / process death). On fire we wake the service which runs any
 * jobs whose runAt has elapsed.
 *
 * Note: an exact alarm scheduled via setExactAndAllowWhileIdle / setAndAllowWhileIdle grants
 * a short temporary allowlist window, so starting a foreground service here is permitted even
 * on Android 12+.
 */
public class SullyNativeRuntimeAlarmReceiver extends BroadcastReceiver {
    static final String ACTION_ALARM_FIRE = "com.sullyos.nativeruntime.ALARM_FIRE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        Intent service = new Intent(context, SullyNativeRuntimeService.class);
        service.setAction(SullyNativeRuntimeService.ACTION_ALARM_WAKE);
        String jobId = intent.getStringExtra("jobId");
        if (jobId != null) service.putExtra("jobId", jobId);
        try {
            SullyNativeRuntimeService.startCompat(context, service);
        } catch (Exception ignored) { /* best-effort wake; boot/next alarm will retry */ }
    }
}
