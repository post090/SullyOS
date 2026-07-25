package com.sullyos.nativeruntime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts the user-enabled always-on foreground service after device boot. */
public class SullyNativeRuntimeBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        boolean enabled = context.getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getBoolean("persistent_enabled", false);
        if (!enabled) return;
        Intent service = new Intent(context, SullyNativeRuntimeService.class);
        service.setAction(SullyNativeRuntimeService.ACTION_START_FOREGROUND);
        service.putExtra("title", "SullyOS 正在运行");
        service.putExtra("text", "");
        SullyNativeRuntimeService.startCompat(context, service);
    }
}
