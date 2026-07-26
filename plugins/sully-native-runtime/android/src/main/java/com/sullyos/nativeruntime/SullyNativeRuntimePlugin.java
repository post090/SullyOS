package com.sullyos.nativeruntime;

import android.content.Context;
import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Iterator;

@CapacitorPlugin(name = "SullyNativeRuntime")
public class SullyNativeRuntimePlugin extends Plugin {

    @PluginMethod
    public void ping(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("platform", "android");
        call.resolve(ret);
    }

    @PluginMethod
    public void startForegroundTask(PluginCall call) {
        String id = call.getString("id", "sully-runtime");
        String kind = call.getString("kind", "generic");
        String title = call.getString("title", "SullyOS 正在运行");
        String text = call.getString("text", "正在处理后台任务");

        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_START_FOREGROUND);
        intent.putExtra("id", id);
        intent.putExtra("kind", kind);
        intent.putExtra("title", title);
        intent.putExtra("text", text);
        SullyNativeRuntimeService.startCompat(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void stopForegroundTask(PluginCall call) {
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_STOP_FOREGROUND);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void enqueueHttpJob(PluginCall call) {
        try {
            String jobId = call.getString("jobId");
            String url = call.getString("url");
            if (jobId == null || jobId.trim().isEmpty()) {
                call.reject("jobId is required");
                return;
            }
            if (url == null || url.trim().isEmpty()) {
                call.reject("url is required");
                return;
            }

            JSONObject job = new JSONObject();
            long now = System.currentTimeMillis();
            job.put("jobId", jobId);
            job.put("status", "queued");
            job.put("createdAt", now);
            job.put("updatedAt", now);
            job.put("timeoutMs", call.getInt("timeoutMs", 120000));
            long runAt = call.getLong("runAt", 0L);
            if (runAt > 0L) job.put("runAt", runAt);
            job.put("responseType", call.getString("responseType", "json"));

            JSONObject request = new JSONObject();
            request.put("url", url);
            request.put("method", call.getString("method", "POST"));
            request.put("headers", toJsonObject(call.getObject("headers", new JSObject())));
            request.put("body", call.getString("body", ""));
            job.put("request", request);

            JSObject meta = call.getObject("meta", null);
            if (meta != null) job.put("meta", toJsonObject(meta));

            SullyNativeRuntimeService.writeJob(getContext(), jobId, job);

            Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
            intent.setAction(SullyNativeRuntimeService.ACTION_ENQUEUE_HTTP);
            intent.putExtra("jobId", jobId);
            intent.putExtra("title", call.getString("title", "SullyOS 正在生成回复"));
            intent.putExtra("text", call.getString("text", "后台请求处理中"));
            SullyNativeRuntimeService.startCompat(getContext(), intent);

            JSObject ret = new JSObject();
            ret.put("jobId", jobId);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null || jobId.trim().isEmpty()) {
            call.reject("jobId is required");
            return;
        }
        try {
            JSONObject job = SullyNativeRuntimeService.readJob(getContext(), jobId);
            JSObject ret = new JSObject();
            ret.put("job", job == null ? null : JSObject.fromJSONObject(job));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void listJobs(PluginCall call) {
        try {
            JSONArray arr = SullyNativeRuntimeService.listJobs(getContext());
            JSArray js = JSArray.from(arr.toString());
            JSObject ret = new JSObject();
            ret.put("jobs", js);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void cancelJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null || jobId.trim().isEmpty()) {
            call.reject("jobId is required");
            return;
        }
        try {
            Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
            intent.setAction(SullyNativeRuntimeService.ACTION_CANCEL_JOB);
            intent.putExtra("jobId", jobId);
            // Clear any scheduled exact alarm for this job even if the service can't start.
            SullyNativeRuntimeService.cancelAlarm(getContext(), jobId);
            try { getContext().startService(intent); } catch (Exception ignored) { /* background start limits */ }
            SullyNativeRuntimeService.markCancelled(getContext(), jobId);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        JSObject result = new JSObject();
        if (android.os.Build.VERSION.SDK_INT < 33) {
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        boolean granted = getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        result.put("granted", granted);
        if (!granted) {
            // Keep the plugin free of an AppCompat dependency. The APK's Settings
            // screen can return here after the user grants the Android permission.
            try {
                android.content.Intent settings = new android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                settings.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                settings.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
            } catch (Exception ignored) { /* permission guidance is best effort */ }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void getSystemStatus(PluginCall call) {
        JSObject result = new JSObject();
        // Notifications enabled?
        boolean notificationsEnabled = true;
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                    notificationsEnabled = nm.areNotificationsEnabled();
                }
            }
        } catch (Exception ignored) { }
        // Battery optimization ignored?
        boolean batteryIgnored = true;
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    batteryIgnored = pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
                }
            }
        } catch (Exception ignored) { }
        // Persistent enabled pref?
        boolean persistentEnabled = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getBoolean("persistent_enabled", false);

        result.put("notificationsEnabled", notificationsEnabled);
        result.put("batteryOptimizationIgnored", batteryIgnored);
        result.put("persistentEnabled", persistentEnabled);
        // Also report POST_NOTIFICATIONS runtime grant for API 33+
        boolean postNotifGranted = true;
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            try {
                postNotifGranted = getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            } catch (Exception ignored) { }
        }
        result.put("postNotificationGranted", postNotifGranted);
        call.resolve(result);
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        JSObject result = new JSObject();
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                result.put("opened", true);
            } else {
                result.put("opened", false);
                result.put("reason", "API < 23");
            }
        } catch (Exception e) {
            // Fallback: open general battery optimization settings
            try {
                android.content.Intent fallback = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                result.put("opened", true);
                result.put("fallback", true);
            } catch (Exception e2) {
                result.put("opened", false);
                result.put("error", e2.getMessage());
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            android.content.Intent settings = new android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            settings.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            settings.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getLaunchRoute(PluginCall call) {
        JSObject result = new JSObject();
        String route = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getString("launch_route", null);
        if (route != null && !route.trim().isEmpty()) result.put("route", route);
        getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .edit().remove("launch_route").apply();
        call.resolve(result);
    }

    @PluginMethod
    public void setPersistentEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .edit().putBoolean("persistent_enabled", enabled).apply();
        call.resolve();
    }

    @PluginMethod
    public void showEventNotification(PluginCall call) {
        String title = call.getString("title", "SullyOS");
        String body = call.getString("body", "");
        String tag = call.getString("tag", "sully-event");
        String route = call.getString("route", "");
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_EVENT_NOTIFICATION);
        intent.putExtra("title", title);
        intent.putExtra("body", body);
        intent.putExtra("tag", tag);
        intent.putExtra("route", route);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void clearJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null || jobId.trim().isEmpty()) {
            call.reject("jobId is required");
            return;
        }
        SullyNativeRuntimeService.cancelAlarm(getContext(), jobId);
        File f = SullyNativeRuntimeService.jobFile(getContext(), jobId);
        if (f.exists()) f.delete();
        call.resolve();
    }

    @PluginMethod
    public void startCallNotification(PluginCall call) {
        String charName = call.getString("charName", "通话中");
        String charId = call.getString("charId", "");
        long startedAt = call.getLong("startedAt", System.currentTimeMillis());
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_CALL_START);
        intent.putExtra("charName", charName);
        intent.putExtra("charId", charId);
        intent.putExtra("startedAt", startedAt);
        SullyNativeRuntimeService.startCompat(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void updateCallNotification(PluginCall call) {
        String charName = call.getString("charName", "通话中");
        String charId = call.getString("charId", "");
        long startedAt = call.getLong("startedAt", 0L);
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_CALL_UPDATE);
        intent.putExtra("charName", charName);
        intent.putExtra("charId", charId);
        intent.putExtra("startedAt", startedAt);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void stopCallNotification(PluginCall call) {
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_CALL_END);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void showMusicNotification(PluginCall call) {
        String title = call.getString("title", "SullyOS 音乐");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        boolean isPlaying = call.getBoolean("isPlaying", true);
        boolean isLiked = call.getBoolean("isLiked", false);
        String songId = call.getString("songId", "");
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_MUSIC_SHOW);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);
        intent.putExtra("album", album);
        intent.putExtra("isPlaying", isPlaying);
        intent.putExtra("isLiked", isLiked);
        intent.putExtra("songId", songId);
        SullyNativeRuntimeService.startCompat(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void updateMusicNotification(PluginCall call) {
        String title = call.getString("title", "SullyOS 音乐");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        boolean isPlaying = call.getBoolean("isPlaying", true);
        boolean isLiked = call.getBoolean("isLiked", false);
        String songId = call.getString("songId", "");
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_MUSIC_UPDATE);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);
        intent.putExtra("album", album);
        intent.putExtra("isPlaying", isPlaying);
        intent.putExtra("isLiked", isLiked);
        intent.putExtra("songId", songId);
        SullyNativeRuntimeService.startCompat(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void stopMusicNotification(PluginCall call) {
        Intent intent = new Intent(getContext(), SullyNativeRuntimeService.class);
        intent.setAction(SullyNativeRuntimeService.ACTION_MUSIC_STOP);
        // Plain startService: if the service isn't running there is nothing to stop, and
        // startForegroundService would force a foreground contract we don't want here.
        try { getContext().startService(intent); } catch (Exception ignored) { /* background start limits */ }
        call.resolve();
    }

    @PluginMethod
    public void getPendingMusicAction(PluginCall call) {
        String action = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getString("pending_music_action", null);
        long at = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getLong("pending_music_action_at", 0L);
        // Only return if within last 10 seconds to avoid stale actions
        JSObject result = new JSObject();
        if (action != null && System.currentTimeMillis() - at < 10000) {
            result.put("action", action);
            // Clear after reading
            getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
                .edit().remove("pending_music_action").remove("pending_music_action_at").apply();
        }
        call.resolve(result);
    }

    @PluginMethod
    public void getCallState(PluginCall call) {
        boolean active = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getBoolean("call_active", false);
        String charId = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getString("call_char_id", null);
        String charName = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getString("call_char_name", null);
        long startedAt = getContext().getSharedPreferences("sully_native_runtime", Context.MODE_PRIVATE)
            .getLong("call_started_at", 0L);
        JSObject result = new JSObject();
        result.put("active", active);
        if (charId != null) result.put("charId", charId);
        if (charName != null) result.put("charName", charName);
        if (startedAt != 0) result.put("startedAt", startedAt);
        call.resolve(result);
    }

    private static JSONObject toJsonObject(JSObject object) throws Exception {
        JSONObject out = new JSONObject();
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = object.get(key);
            out.put(key, value);
        }
        return out;
    }
}
