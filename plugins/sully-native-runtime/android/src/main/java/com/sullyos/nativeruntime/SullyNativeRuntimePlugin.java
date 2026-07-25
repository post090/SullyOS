package com.sullyos.nativeruntime;

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
            getContext().startService(intent);
            SullyNativeRuntimeService.markCancelled(getContext(), jobId);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
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
        File f = SullyNativeRuntimeService.jobFile(getContext(), jobId);
        if (f.exists()) f.delete();
        call.resolve();
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
