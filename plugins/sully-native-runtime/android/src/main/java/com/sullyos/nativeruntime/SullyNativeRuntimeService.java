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

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
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

    private static final String CHANNEL_ID = "sully_native_runtime";
    private static final int NOTIFICATION_ID = 31090;
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();
    private static final AtomicInteger RUNNING_JOBS = new AtomicInteger(0);
    private static final Set<String> CANCELLED = ConcurrentHashMap.newKeySet();
    private static final ConcurrentHashMap<String, HttpURLConnection> CONNECTIONS = new ConcurrentHashMap<>();
    private static volatile boolean manualForeground = false;

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
                intent.getStringExtra("tag")
            );
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (ACTION_START_FOREGROUND.equals(action)) {
            manualForeground = true;
            startForegroundCompat(
                intent.getStringExtra("title"),
                intent.getStringExtra("text")
            );
            return START_STICKY;
        }
        if (ACTION_STOP_FOREGROUND.equals(action)) {
            manualForeground = false;
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
            RUNNING_JOBS.incrementAndGet();
            EXECUTOR.execute(() -> runHttpJob(jobId));
            return START_REDELIVER_INTENT;
        }
        return START_NOT_STICKY;
    }

    private void runHttpJob(String jobId) {
        try {
            JSONObject job = readJob(this, jobId);
            if (job == null) throw new IllegalStateException("job file not found");
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

    private void showEventNotification(String title, String body, String tag) {
        ensureChannel(this);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Notification notification = buildNotification(
            title == null || title.trim().isEmpty() ? "SullyOS" : title,
            body == null ? "" : body,
            false
        );
        int id = 32000 + Math.abs((tag == null ? "sully-event" : tag).hashCode() % 10000);
        manager.notify(tag == null ? "sully-event" : tag, id, notification);
    }

    private void startForegroundCompat(String title, String text) {
        ensureChannel(this);
        startForeground(NOTIFICATION_ID, buildNotification(
            title == null || title.trim().isEmpty() ? "SullyOS 正在运行" : title,
            text == null || text.trim().isEmpty() ? "" : text,
            true
        ));
    }

    private Notification buildNotification(String title, String text, boolean ongoing) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = null;
        if (launchIntent != null) {
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
        if (manualForeground || RUNNING_JOBS.get() > 0) return;
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
