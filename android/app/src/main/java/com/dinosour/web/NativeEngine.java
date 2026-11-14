package com.dinosour.web;

import android.content.Context;
import android.webkit.WebResourceResponse;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.FutureTask;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Public-video extraction and HTTP requests run on the phone, never on a PC. */
final class NativeEngine {
    static final String USER_AGENT = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    interface Callback { void result(String id, JSONObject payload); }
    private final Context context;
    private final Callback callback;
    private final ThreadPoolExecutor http = pool(6, 40);
    private final ThreadPoolExecutor extract = pool(2, 6);
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, FutureTask<Void>> jobs = new ConcurrentHashMap<>();
    private final AtomicBoolean closed = new AtomicBoolean();
    private boolean runtimeReady;

    NativeEngine(Context context, Callback callback) {
        this.context = context.getApplicationContext();
        this.callback = callback;
    }

    private static ThreadPoolExecutor pool(int count, int queue) {
        return new ThreadPoolExecutor(count, count, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(queue));
    }

    void request(String id, String kind, String raw) {
        if (closed.get() || !id.matches("\\d{13}-\\d{1,8}") || raw.length() > 100000) return;
        FutureTask<Void> job = new FutureTask<>(() -> {
            try {
                JSONObject input = new JSONObject(raw);
                Object result;
                if ("extract".equals(kind)) result = video(input.getString("id"), id);
                else if ("http".equals(kind)) result = fetch(input);
                else throw new IllegalArgumentException("Unsupported request.");
                reply(id, result, null);
            } catch (Exception error) {
                if (!Thread.currentThread().isInterrupted()) reply(id, null, friendly(error));
            } finally { jobs.remove(id); }
            return null;
        });
        if (jobs.putIfAbsent(id, job) != null) return;
        try {
            ("extract".equals(kind) ? extract : http).execute(job);
            final java.util.concurrent.ScheduledFuture<?> deadline = timer.schedule(() -> {
                if (jobs.containsKey(id)) {
                    reply(id, null, "The connection took too long. Please retry.");
                    cancel(id);
                }
            }, "extract".equals(kind) ? 100 : 22, TimeUnit.SECONDS);
            // Deadlines are tiny and bounded; remove cancelled ones promptly.
            if (job.isDone()) deadline.cancel(false);
        } catch (java.util.concurrent.RejectedExecutionException error) {
            reply(id, null, "A few videos are loading. Please try again in a moment.");
            jobs.remove(id);
        }
    }

    private void reply(String id, Object result, String error) {
        if (closed.get() || !jobs.containsKey(id)) return;
        try {
            JSONObject payload = new JSONObject().put("ok", error == null);
            if (error == null) payload.put("result", result);
            else payload.put("error", error);
            callback.result(id, payload);
        } catch (Exception ignored) { }
    }

    void cancel(String id) {
        FutureTask<Void> task = jobs.remove(id);
        if (task != null) {
            task.cancel(true);
            YoutubeDL.getInstance().destroyProcessById("dinosour-" + id);
        }
    }

    private String video(String id, String jobId) throws Exception {
        if (!id.matches("[A-Za-z0-9_-]{11}")) throw new IllegalArgumentException("Invalid video ID.");
        prepareRuntime();
        YoutubeDLRequest request = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
        request.addOption("--ignore-config");
        request.addOption("--no-warnings");
        request.addOption("--no-playlist");
        request.addOption("--skip-download");
        request.addOption("--dump-single-json");
        request.addOption("--socket-timeout", "12");
        request.addOption("--retries", "1");
        request.addOption("--extractor-retries", "1");
        request.addOption("--user-agent", USER_AGENT);
        return YoutubeDL.getInstance().execute(request, "dinosour-" + jobId, null).getOut();
    }

    private synchronized void prepareRuntime() throws Exception {
        if (runtimeReady) return;
        YoutubeDL.getInstance().init(context);
        android.content.SharedPreferences prefs = context.getSharedPreferences("native_engine", Context.MODE_PRIVATE);
        java.io.File directory = new java.io.File(context.getNoBackupFilesDir(), "youtubedl-android/yt-dlp");
        java.io.File target = new java.io.File(directory, "yt-dlp");
        if (!Config.ENGINE_VERSION.equals(prefs.getString("version", "")) || !target.exists()) {
            java.io.File temporary = new java.io.File(directory, "yt-dlp.tmp");
            try (InputStream source = context.getAssets().open("engine/yt-dlp");
                 java.io.FileOutputStream out = new java.io.FileOutputStream(temporary)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = source.read(buffer)) != -1) out.write(buffer, 0, count);
                out.getFD().sync();
            }
            if (!temporary.renameTo(target)) throw new java.io.IOException("Could not initialize playback runtime.");
            prefs.edit().putString("version", Config.ENGINE_VERSION).apply();
        }
        runtimeReady = true;
    }

    static String friendly(Exception error) {
        String message = String.valueOf(error.getMessage()).toLowerCase(Locale.ROOT);
        if (message.contains("sign in") || message.contains("confirm") && message.contains("bot"))
            return "YouTube requires sign-in or has temporarily limited this connection. Try another public video.";
        if (message.contains("private") || message.contains("age-restricted") || message.contains("members-only"))
            return "This video is restricted. Choose a public video.";
        if (error instanceof IllegalArgumentException) return error.getMessage();
        if (message.contains("initialize") || message.contains("python") || message.contains("permission denied"))
            return "The playback engine could not start. Reopen the app or check for an app update.";
        return "Could not load from YouTube. Check your Wi-Fi or mobile data and retry.";
    }

    private static URL allowedUrl(String value) throws Exception {
        URL url = new URL(value);
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null ||
                (url.getPort() != -1 && url.getPort() != 443) ||
                !(host.equals("www.youtube.com") || host.equals("youtube.com") ||
                  host.equals("suggestqueries.google.com") || host.equals("i.ytimg.com"))) {
            throw new IllegalArgumentException("Unsupported network destination.");
        }
        return url;
    }

    private JSONObject fetch(JSONObject input) throws Exception {
        URL url = allowedUrl(input.getString("url"));
        String method = input.optString("method", "GET");
        if (!method.equals("GET") && !method.equals("POST")) throw new IllegalArgumentException("Unsupported request method.");
        JSONObject headers = input.optJSONObject("headers");
        byte[] body = input.isNull("body") ? null : input.optString("body", "").getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = connect(url, method, headers, body, 0);
        try {
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] bytes = read(stream, 16 * 1024 * 1024);
            String type = connection.getContentType();
            return new JSONObject().put("status", status)
                    .put("headers", new JSONObject().put("content-type", type == null ? "application/json" : type))
                    .put("body", new String(bytes, StandardCharsets.UTF_8));
        } finally { connection.disconnect(); }
    }

    private static HttpURLConnection connect(URL url, String method, JSONObject headers, byte[] body, int redirects) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setRequestProperty("User-Agent", USER_AGENT);
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (headers != null) {
            for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
                String key = keys.next();
                if (java.util.Arrays.asList("accept", "accept-language", "content-type", "cookie", "origin", "user-agent").contains(key.toLowerCase(Locale.ROOT)))
                    connection.setRequestProperty(key, headers.getString(key));
            }
        }
        try {
            if (body != null && "POST".equals(method)) {
                connection.setDoOutput(true);
                try (java.io.OutputStream out = connection.getOutputStream()) { out.write(body); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status <= 308 && connection.getHeaderField("Location") != null) {
                URL target = allowedUrl(new URL(url, connection.getHeaderField("Location")).toString());
                connection.disconnect();
                if (redirects >= 3) throw new IllegalArgumentException("Too many redirects.");
                boolean get = status == 303 || (status == 301 || status == 302) && method.equals("POST");
                return connect(target, get ? "GET" : method, headers, get ? null : body, redirects + 1);
            }
            return connection;
        } catch (Exception error) { connection.disconnect(); throw error; }
    }

    static byte[] read(InputStream input, int max) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                if (out.size() + count > max) throw new IllegalArgumentException("The response is too large.");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    WebResourceResponse thumbnail(String id, boolean shortVideo) {
        if (!id.matches("[A-Za-z0-9_-]{11}")) return empty(404);
        for (String image : shortVideo ? new String[]{"oar2", "hqdefault"} : new String[]{"hqdefault"}) {
            HttpURLConnection connection = null;
            try {
                connection = connect(allowedUrl("https://i.ytimg.com/vi/" + id + "/" + image + ".jpg"), "GET", null, null, 0);
                if (connection.getResponseCode() != 200) continue;
                byte[] bytes = read(connection.getInputStream(), 2 * 1024 * 1024);
                return new WebResourceResponse("image/jpeg", null, 200, "OK",
                        Collections.singletonMap("Cache-Control", "max-age=1800"), new ByteArrayInputStream(bytes));
            } catch (Exception ignored) { }
            finally { if (connection != null) connection.disconnect(); }
        }
        return empty(404);
    }

    static WebResourceResponse empty(int status) {
        return new WebResourceResponse("text/plain", "UTF-8", status, "Unavailable",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    void close() {
        closed.set(true);
        for (String id : jobs.keySet()) cancel(id);
        http.shutdownNow(); extract.shutdownNow(); timer.shutdownNow();
    }
}
