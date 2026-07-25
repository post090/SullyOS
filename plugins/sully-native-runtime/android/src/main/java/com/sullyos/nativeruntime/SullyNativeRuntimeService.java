package com.sullyos.nativeruntime;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class SullyNativeRuntimeService extends Service {
    public static final String ACTION_START_FOREGROUND = "com.sullyos.nativeruntime.START_FOREGROUND";
    public static final String ACTION_STOP_FOREGROUND = "com.sullyos.nativeruntime.STOP_FOREGROUND";
    public static final String ACTION_ENQUEUE_HTTP = "com.sullyos.nativeruntime.ENQUEUE_HTTP";
    public static final String ACTION_CANCEL_JOB = "com.sullyos.nativeruntime.CANCEL_JOB";
    public static final String ACTION_EVENT_NOTIFICATION = "com.sullyos.nativeruntime.EVENT_NOTIFICATION";
    public static final String ACTION_CALL_START = "com.sullyos.nativeruntime.CALL_START";
    public static final String ACTION_CALL_UPDATE = "com.sullyos.nativeruntime.CALL_UPDATE";
    public static final String ACTION_CALL_END = "com.sullyos.nativeruntime.CALL_END";
    public static final String ACTION_MUSIC_SHOW = "com.sullyos.nativeruntime.MUSIC_SHOW";
    public static final String ACTION_MUSIC_UPDATE = "com.sullyos.nativeruntime.MUSIC_UPDATE";
    public static final String ACTION_MUSIC_STOP = "com.sullyos.nativeruntime.MUSIC_STOP";
    public static final String ACTION_MUSIC_ACTION = "com.sullyos.nativeruntime.MUSIC_ACTION";

    private static final String CHANNEL_ID = "sully_native_runtime";
    private static final String CHANNEL_CALL = "sully_call";
    private static final String CHANNEL_MUSIC = "sully_music";
    private static final int NOTIFICATION_ID = 31090;
    private static final int NOTIFICATION_CALL_ID = 31091;
    private static final int NOTIFICATION_MUSIC_ID = 31092;
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();
    private static final AtomicInteger RUNNING_JOBS = new AtomicInteger(0);
    private static final Set<String> CANCELLED = ConcurrentHashMap.newKeySet();
    private static final Set<String> ACTIVE_JOB_IDS = ConcurrentHashMap.newKeySet();
    private static final ConcurrentHashMap<String, HttpURLConnection> CONNECTIONS = new ConcurrentHashMap<>();
    private static volatile boolean manualForeground = false;
    // Call tracking for resume
    private static volatile long callStartedAtMs = 0;
    private static volatile String callCharId = null;
    private static volatile String callCharName = null;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_EVENT_NOTIFICATION.equals(action)) {
            showEventNotification(
                intent.getStringExtra("title"),
                intent.getStringExtra("body"),
                intent.getStringExtra("tag"),
                intent.getStringExtra("route")
            );
            if (manualForeground) {
                return START_STICKY;
            }
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (ACTION_CALL_START.equals(action)) {
            String charName = intent.getStringExtra("charName");
            String charId = intent.getStringExtra("charId");
            long startedAt = intent.getLongExtra("startedAt", System.currentTimeMillis());
            callCharId = charId;
            callCharName = charName;
            callStartedAtMs = startedAt;
            // Persist for resume after WebView death
            getSharedPreferences("sully_native_runtime", MODE_PRIVATE).edit()
                .putString("call_char_id", charId)
                .putString("call_char_name", charName)
                .putLong("call_started_at", startedAt)
                .putBoolean("call_active", true)
                .apply();
            startForegroundCompatWithCall(charName, startedAt);
            return START_STICKY;
        }
        if (ACTION_CALL_UPDATE.equals(action)) {
            String charName = intent.getStringExtra("charName");
            long startedAt = intent.getLongExtra("startedAt", callStartedAtMs);
            String charId = intent.getStringExtra("charId");
            if (charId != null) callCharId = charId;
            if (charName != null) callCharName = charName;
            if (startedAt != 0) callStartedAtMs = startedAt;
            updateCallNotification(charName != null ? charName : callCharName, callStartedAtMs);
            return START_STICKY;
        }
        if (ACTION_CALL_END.equals(action)) {
            stopCallNotification();
            callCharId = null;
            callCharName = null;
            callStartedAtMs = 0;
            getSharedPreferences("sully_native_runtime", MODE_PRIVATE).edit()
                .putBoolean("call_active", false)
                .remove("call_char_id")
                .remove("call_char_name")
                .remove("call_started_at")
                .apply();
            maybeStop();
            return START_NOT_STICKY;
        }
        if (ACTION_MUSIC_SHOW.equals(action) || ACTION_MUSIC_UPDATE.equals(action)) {
            String title = intent.getStringExtra("title");
            String artist = intent.getStringExtra("artist");
            String album = intent.getStringExtra("album");
            boolean isPlaying = intent.getBooleanExtra("isPlaying", true);
            boolean isLiked = intent.getBooleanExtra("isLiked", false);
            String songId = intent.getStringExtra("songId");
            showMusicNotification(title, artist, album, isPlaying, isLiked, songId);
            return START_STICKY;
        }
        if (ACTION_MUSIC_STOP.equals(action)) {
            stopMusicNotification();
            return START_NOT_STICKY;
        }
        if (ACTION_MUSIC_ACTION.equals(action)) {
            String musicAction = intent.getStringExtra("musicAction");
            if (musicAction != null && !musicAction.trim().isEmpty()) {
                // Store pending action for JS to consume on resume
                getSharedPreferences("sully_native_runtime", MODE_PRIVATE).edit()
                    .putString("pending_music_action", musicAction)
                    .putLong("pending_music_action_at", System.currentTimeMillis())
                    .apply();
                // Launch app so JS can handle it
                Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
                if (launchIntent != null) {
                    launchIntent.putExtra("sully_music_action", musicAction);
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    try { startActivity(launchIntent); } catch (Exception ignored) {}
                }
            }
            return START_NOT_STICKY;
        }
        if (ACTION_START_FOREGROUND.equals(action)) {
            manualForeground = true;
            startForegroundCompat(
                intent.getStringExtra("title"),
                intent.getStringExtra("text")
            );
            resumePendingJobs();
            // If there was an active call persisted, restore its notification
            boolean wasCallActive = getSharedPreferences("sully_native_runtime", MODE_PRIVATE).getBoolean("call_active", false);
            if (wasCallActive) {
                String savedName = getSharedPreferences("sully_native_runtime", MODE_PRIVATE).getString("call_char_name", null);
                long savedStarted = getSharedPreferences("sully_native_runtime", MODE_PRIVATE).getLong("call_started_at", System.currentTimeMillis());
                String savedCharId = getSharedPreferences("sully_native_runtime", MODE_PRIVATE).getString("call_char_id", null);
                if (savedName != null) {
                    callCharName = savedName;
                    callCharId = savedCharId;
                    callStartedAtMs = savedStarted;
                    // Re-show call notification as foreground? We already have foreground from persistent,
                    // so show call as separate notification (not foreground) to avoid replacing persistent.
                    updateCallNotification(savedName, savedStarted);
                }
            }
            return START_STICKY;
        }
        if (ACTION_STOP_FOREGROUND.equals(action)) {
            manualForeground = false;
            // If call is still active, keep service alive for call
            if (callStartedAtMs != 0) {
                return START_STICKY;
            }
            maybeStop();
            return START_NOT_STICKY;
        }
        if (ACTION_CANCEL_JOB.equals(action)) {
            String jobId = intent.getStringExtra("jobId");
            if (jobId != null) {
                CANCELLED.add(jobId);
                HttpURLConnection conn = CONNECTIONS.get(jobId);
                if (conn != null) conn.disconnect();
                try { markCancelled(this, jobId); } catch (Exception ignored) {}
            }
            maybeStop();
            return START_NOT_STICKY;
        }
        if (ACTION_ENQUEUE_HTTP.equals(action)) {
            String jobId = intent.getStringExtra("jobId");
            if (jobId == null) return START_NOT_STICKY;
            startForegroundCompat(
                intent.getStringExtra("title"),
                intent.getStringExtra("text")
            );
            if (ACTIVE_JOB_IDS.add(jobId)) {
                RUNNING_JOBS.incrementAndGet();
                EXECUTOR.execute(() -> runHttpJob(jobId));
            }
            return START_REDELIVER_INTENT;
        }
        return START_NOT_STICKY;
    }

    private void resumePendingJobs() {
        File[] files = jobsDir(this).listFiles();
        if (files == null) return;
        for (File file : files) {
            try {
                JSONObject job = new JSONObject(readAll(new FileInputStream(file)));
                String status = job.optString("status", "");
                if (!"queued".equals(status) && !"running".equals(status)) continue;
                String jobId = job.optString("jobId", "");
                if (jobId.isEmpty()) continue;
                if (!ACTIVE_JOB_IDS.add(jobId)) continue;
                RUNNING_JOBS.incrementAndGet();
                EXECUTOR.execute(() -> runHttpJob(jobId));
            } catch (Exception ignored) { /* malformed job is left for recovery diagnostics */ }
        }
    }

    private void runHttpJob(String jobId) {
        try {
            JSONObject job = readJob(this, jobId);
            if (job == null) throw new IllegalStateException("job file not found");
            if (CANCELLED.contains(jobId)) {
                markCancelled(this, jobId);
                return;
            }
            long runAt = job.optLong("runAt", 0L);
            if (runAt > System.currentTimeMillis()) {
                Thread.sleep(Math.min(runAt - System.currentTimeMillis(), 2_147_000_000L));
            }
            if (CANCELLED.contains(jobId)) {
                markCancelled(this, jobId);
                return;
            }
            JSONObject request = job.getJSONObject("request");
            updateJobStatus(job, "running", null);
            writeJob(this, jobId, job);

            HttpResult result = executeRequest(jobId, request, job.optInt("timeoutMs", 120000));
            if (CANCELLED.contains(jobId)) {
                markCancelled(this, jobId);
                return;
            }

            JSONObject done = baseFinishedJob(job, "completed");
            JSONObject response = new JSONObject();
            response.put("statusCode", result.statusCode);
            response.put("headers", result.headers);
            response.put("body", result.body);
            done.put("response", response);
            writeJob(this, jobId, done);
        } catch (Exception e) {
            try {
                JSONObject job = readJob(this, jobId);
                JSONObject failed = job == null ? new JSONObject() : baseFinishedJob(job, "failed");
                long now = System.currentTimeMillis();
                if (!failed.has("jobId")) failed.put("jobId", jobId);
                if (!failed.has("createdAt")) failed.put("createdAt", now);
                failed.put("status", "failed");
                failed.put("updatedAt", now);
                failed.put("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
                writeJob(this, jobId, failed);
            } catch (Exception ignored) {}
        } finally {
            CONNECTIONS.remove(jobId);
            CANCELLED.remove(jobId);
            ACTIVE_JOB_IDS.remove(jobId);
            RUNNING_JOBS.decrementAndGet();
            maybeStop();
        }
    }

    private HttpResult executeRequest(String jobId, JSONObject request, int timeoutMs) throws Exception {
        String method = request.optString("method", "POST").toUpperCase();
        URL url = new URL(request.getString("url"));
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        CONNECTIONS.put(jobId, conn);
        conn.setRequestMethod(method);
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setInstanceFollowRedirects(true);
        conn.setDoInput(true);

        JSONObject headers = request.optJSONObject("headers");
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = headers.optString(key, "");
                if (!key.trim().isEmpty()) conn.setRequestProperty(key, value);
            }
        }

        String body = request.optString("body", "");
        if (!"GET".equals(method) && body.length() > 0) {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
        }

        int status = conn.getResponseCode();
        InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String text = readAll(stream);

        JSONObject responseHeaders = new JSONObject();
        for (String key : conn.getHeaderFields().keySet()) {
            if (key == null) continue;
            responseHeaders.put(key.toLowerCase(), conn.getHeaderField(key));
        }
        conn.disconnect();
        return new HttpResult(status, responseHeaders, text);
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = stream.read(buf)) >= 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static JSONObject baseFinishedJob(JSONObject job, String status) throws Exception {
        JSONObject out = new JSONObject();
        long now = System.currentTimeMillis();
        out.put("jobId", job.getString("jobId"));
        out.put("status", status);
        out.put("createdAt", job.optLong("createdAt", now));
        out.put("updatedAt", now);
        out.put("timeoutMs", job.optInt("timeoutMs", 120000));
        if (job.has("runAt")) out.put("runAt", job.optLong("runAt"));
        out.put("responseType", job.optString("responseType", "json"));
        if (job.has("meta")) out.put("meta", job.getJSONObject("meta"));
        JSONObject req = job.optJSONObject("request");
        if (req != null) {
            JSONObject safeReq = new JSONObject();
            safeReq.put("url", req.optString("url"));
            safeReq.put("method", req.optString("method", "POST"));
            out.put("request", safeReq);
        }
        return out;
    }

    private static void updateJobStatus(JSONObject job, String status, String error) throws Exception {
        job.put("status", status);
        job.put("updatedAt", System.currentTimeMillis());
        if (error != null) job.put("error", error);
    }

    public static void markCancelled(Context context, String jobId) throws Exception {
        JSONObject job = readJob(context, jobId);
        if (job == null) job = new JSONObject().put("jobId", jobId).put("createdAt", System.currentTimeMillis());
        JSONObject cancelled = baseFinishedJob(job, "cancelled");
        writeJob(context, jobId, cancelled);
    }

    private void showEventNotification(String title, String body, String tag, String route) {
        ensureChannel(this);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Notification notification = buildNotification(
            title == null || title.trim().isEmpty() ? "SullyOS" : title,
            body == null ? "" : body,
            false,
            route
        );
        int id = 32000 + Math.abs((tag == null ? "sully-event" : tag).hashCode() % 10000);
        manager.notify(tag == null ? "sully-event" : tag, id, notification);
    }

    private void startForegroundCompat(String title, String text) {
        ensureChannel(this);
        startForeground(NOTIFICATION_ID, buildNotification(
            title == null || title.trim().isEmpty() ? "SullyOS 正在运行" : title,
            text == null || text.trim().isEmpty() ? "" : text,
            true,
            null
        ));
    }

    private void startForegroundCompatWithCall(String charName, long startedAtMs) {
        ensureChannel(this);
        ensureCallChannel(this);
        // charId is stored in static field callCharId, use it for route if available
        String rawRoute = callCharId != null ? callCharId : (charName != null ? charName : "call");
        String routeCallId = rawRoute.startsWith("call:") ? rawRoute : "call:" + rawRoute;
        Notification notification = buildCallNotification(
            charName == null || charName.trim().isEmpty() ? "通话中" : "正在与 " + charName + " 通话",
            "轻触返回通话 · " + formatCallDuration(System.currentTimeMillis() - startedAtMs),
            startedAtMs,
            routeCallId
        );
        startForeground(NOTIFICATION_CALL_ID, notification);
    }

    private void updateCallNotification(String charName, long startedAtMs) {
        ensureChannel(this);
        ensureCallChannel(this);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String rawRoute = callCharId != null ? callCharId : (charName != null ? charName : "call");
        String routeCallId = rawRoute.startsWith("call:") ? rawRoute : "call:" + rawRoute;
        Notification notification = buildCallNotification(
            charName == null || charName.trim().isEmpty() ? "通话中" : "正在与 " + charName + " 通话",
            "轻触返回通话 · " + formatCallDuration(System.currentTimeMillis() - startedAtMs),
            startedAtMs,
            routeCallId
        );
        manager.notify("sully-call", NOTIFICATION_CALL_ID, notification);
    }

    private static String formatCallDuration(long elapsedMs) {
        if (elapsedMs <= 0) return "00:00";
        long totalSec = elapsedMs / 1000;
        long min = totalSec / 60;
        long sec = totalSec % 60;
        return String.format("%02d:%02d", min, sec);
    }

    private void stopCallNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel("sully-call", NOTIFICATION_CALL_ID);
        }
        // If persistent mode is still enabled, restore its foreground notification
        if (manualForeground) {
            startForegroundCompat("SullyOS 正在运行", "");
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        }
    }

    private Notification buildCallNotification(String title, String text, long startedAtMs, String charIdForRoute) {
        ensureCallChannel(this);
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;
        if (launchIntent != null) {
            launchIntent.putExtra("sully_route", charIdForRoute != null ? charIdForRoute : "call");
            launchIntent.putExtra("sully_call_resume", true);
            getSharedPreferences("sully_native_runtime", MODE_PRIVATE).edit()
                .putString("launch_route", charIdForRoute != null ? charIdForRoute : "call")
                .apply();
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            contentIntent = PendingIntent.getActivity(this, 93091, launchIntent, flags);
        }

        // Hangup action
        Intent hangupIntent = new Intent(this, SullyNativeRuntimeService.class);
        hangupIntent.setAction(ACTION_CALL_END);
        int hangupFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) hangupFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent hangupPending = PendingIntent.getService(this, 93092, hangupIntent, hangupFlags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_CALL);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .setShowWhen(true)
            .setWhen(startedAtMs > 0 ? startedAtMs : System.currentTimeMillis())
            .setUsesChronometer(true)
            .setContentIntent(contentIntent)
            .setCategory(Notification.CATEGORY_CALL);

        // Add hangup action for Android
        builder.addAction(new Notification.Action.Builder(
            null,
            "挂断",
            hangupPending
        ).build());

        return builder.build();
    }

    private void showMusicNotification(String title, String artist, String album, boolean isPlaying, boolean isLiked, String songId) {
        ensureChannel(this);
        ensureMusicChannel(this);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        String contentTitle = title != null && !title.trim().isEmpty() ? title : "SullyOS 音乐";
        String contentText = artist != null && !artist.trim().isEmpty() ? artist : (album != null ? album : "正在播放");

        Notification notification = buildMusicNotification(contentTitle, contentText, isPlaying, isLiked, songId);
        manager.notify("sully-music", NOTIFICATION_MUSIC_ID, notification);
    }

    private void stopMusicNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel("sully-music", NOTIFICATION_MUSIC_ID);
        }
    }

    private Notification buildMusicNotification(String title, String artist, boolean isPlaying, boolean isLiked, String songId) {
        ensureMusicChannel(this);

        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;
        if (launchIntent != null) {
            launchIntent.putExtra("sully_route", "music");
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            contentIntent = PendingIntent.getActivity(this, 94091, launchIntent, flags);
        }

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_MUSIC);
        } else {
            builder = new Notification.Builder(this);
        }

        builder.setContentTitle(title)
            .setContentText(artist)
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(isPlaying) // ongoing when playing, swipe-dismissable when paused
            .setShowWhen(false)
            .setContentIntent(contentIntent);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setCategory(Notification.CATEGORY_TRANSPORT);
        }

        // Build action pending intents
        PendingIntent prevPending = buildMusicActionPendingIntent("prev", 94092);
        PendingIntent togglePending = buildMusicActionPendingIntent(isPlaying ? "pause" : "play", 94093);
        PendingIntent nextPending = buildMusicActionPendingIntent("next", 94094);
        PendingIntent likePending = buildMusicActionPendingIntent(isLiked ? "unlike" : "like", 94095);

        // Order: like, prev, play/pause, next
        String likeTitle = isLiked ? "取消喜欢" : "喜欢";
        builder.addAction(new Notification.Action.Builder(null, likeTitle, likePending).build());
        builder.addAction(new Notification.Action.Builder(null, "上一首", prevPending).build());
        String toggleTitle = isPlaying ? "暂停" : "播放";
        builder.addAction(new Notification.Action.Builder(null, toggleTitle, togglePending).build());
        builder.addAction(new Notification.Action.Builder(null, "下一首", nextPending).build());

        // For Android 10+, we could use MediaStyle, but keep simple for compatibility
        return builder.build();
    }

    private PendingIntent buildMusicActionPendingIntent(String action, int requestCode) {
        Intent intent = new Intent(this, SullyNativeRuntimeService.class);
        intent.setAction(ACTION_MUSIC_ACTION);
        intent.putExtra("musicAction", action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, requestCode, intent, flags);
    }

    private Notification buildNotification(String title, String text, boolean ongoing, String route) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = null;
        if (launchIntent != null) {
            if (route != null && !route.trim().isEmpty()) {
                launchIntent.putExtra("sully_route", route);
                getSharedPreferences("sully_native_runtime", MODE_PRIVATE)
                    .edit().putString("launch_route", route).apply();
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setContentTitle(title)
            .setSmallIcon(getApplicationInfo().icon)
        ;
        if (text != null && !text.trim().isEmpty()) {
            builder.setContentText(text);
        }
        builder
            .setOngoing(ongoing)
            .setShowWhen(false)
            .setContentIntent(pendingIntent);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setCategory(Notification.CATEGORY_SERVICE);
        }
        return builder.build();
    }

    private void maybeStop() {
        if (manualForeground || RUNNING_JOBS.get() > 0 || callStartedAtMs != 0) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    public static void startCompat(Context context, Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "SullyOS 后台任务",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("SullyOS APK 原生后台任务与生成保活");
        manager.createNotificationChannel(channel);
    }

    private static void ensureCallChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_CALL) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_CALL,
            "SullyOS 通话",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("正在进行的通话");
        channel.setShowBadge(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            channel.setAllowBubbles(false);
        }
        manager.createNotificationChannel(channel);
    }

    private static void ensureMusicChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_MUSIC) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_MUSIC,
            "SullyOS 音乐",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("正在播放的音乐");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    public static File jobsDir(Context context) {
        File dir = new File(context.getFilesDir(), "native-jobs");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    public static File jobFile(Context context, String jobId) {
        String safe = jobId.replaceAll("[^a-zA-Z0-9._-]", "_");
        return new File(jobsDir(context), safe + ".json");
    }

    public static synchronized void writeJob(Context context, String jobId, JSONObject job) throws Exception {
        File f = jobFile(context, jobId);
        try (FileOutputStream fos = new FileOutputStream(f, false)) {
            fos.write(job.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    public static synchronized JSONObject readJob(Context context, String jobId) throws Exception {
        File f = jobFile(context, jobId);
        if (!f.exists()) return null;
        try (FileInputStream fis = new FileInputStream(f)) {
            return new JSONObject(readAll(fis));
        }
    }

    public static synchronized JSONArray listJobs(Context context) throws Exception {
        JSONArray arr = new JSONArray();
        File[] files = jobsDir(context).listFiles();
        if (files == null) return arr;
        for (File f : files) {
            if (!f.isFile() || !f.getName().endsWith(".json")) continue;
            try (FileInputStream fis = new FileInputStream(f)) {
                arr.put(new JSONObject(readAll(fis)));
            } catch (Exception ignored) {}
        }
        return arr;
    }

    private static class HttpResult {
        final int statusCode;
        final JSONObject headers;
        final String body;
        HttpResult(int statusCode, JSONObject headers, String body) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.body = body;
        }
    }
}
