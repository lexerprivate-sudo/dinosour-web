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
    // File transfers run one at a time on their own thread so an offline
    // download never floods mobile data while the user is browsing.
    private final ThreadPoolExecutor downloadPool = pool(1, 8);
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, FutureTask<Void>> jobs = new ConcurrentHashMap<>();
    private final Map<String, FutureTask<Void>> downloadJobs = new ConcurrentHashMap<>();
    private final Object downloadGate = new Object();
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
                else if ("download".equals(kind)) result = beginDownload(input.getString("id"), id, intOf(input, "height", -1));
                else if ("download-stat".equals(kind)) result = downloadStat(input.getString("id"));
                else if ("download-cancel".equals(kind)) { removeDownload(input.getString("id")); result = okResult(); }
                else if ("download-delete".equals(kind)) { removeDownload(input.getString("id")); result = okResult(); }
                else throw new IllegalArgumentException("That request isn't supported.");
                reply(id, result, null);
            } catch (Exception error) {
                if (!Thread.currentThread().isInterrupted()) reply(id, null, friendly(error));
            } finally { jobs.remove(id); }
            return null;
        });
        if (jobs.putIfAbsent(id, job) != null) return;
        final boolean deferred = "download".equals(kind);
        try {
            ("extract".equals(kind) || deferred ? extract : http).execute(job);
            // The download kind forks its own transfer onto the download pool;
            // preparation runs inline and must not die under the usual deadline.
            if (!deferred) {
                final java.util.concurrent.ScheduledFuture<?> deadline = timer.schedule(() -> {
                    if (jobs.containsKey(id)) {
                        reply(id, null, "The connection took too long. Please retry.");
                        cancel(id);
                    }
                }, "extract".equals(kind) ? 100 : 22, TimeUnit.SECONDS);
                // Deadlines are tiny and bounded; remove cancelled ones promptly.
                if (job.isDone()) deadline.cancel(false);
            }
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
            throw new IllegalArgumentException("That link isn't supported in this app.");
        }
        return url;
    }

    private JSONObject fetch(JSONObject input) throws Exception {
        URL url = allowedUrl(input.getString("url"));
        String method = input.optString("method", "GET");
        if (!method.equals("GET") && !method.equals("POST")) throw new IllegalArgumentException("That request isn't supported.");
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
        for (String id : downloadJobs.keySet()) {
            FutureTask<Void> task = downloadJobs.remove(id);
            if (task != null) task.cancel(true);
            YoutubeDL.getInstance().destroyProcessById("dinosour-dl-" + id);
        }
        http.shutdownNow(); extract.shutdownNow(); downloadPool.shutdownNow(); timer.shutdownNow();
    }

    // ---- Offline downloads ---------------------------------------------------

    // Preparation (extraction, format choice, storage check, meta write and
    // forking the transfer) runs inline on the calling executor. The transfer
    // itself continues on the download pool after the reply has been sent.
    private JSONObject beginDownload(String id, String jobId, int height) throws Exception {
        if (!id.matches("[A-Za-z0-9_-]{11}")) throw new IllegalArgumentException("Invalid video ID.");
        String json = video(id, jobId);
        JSONObject info = new JSONObject(json);
        org.json.JSONArray formats = info.optJSONArray("formats");
        if (formats == null) throw new IllegalArgumentException("No compatible download streams are available for this video.");
        JSONObject videoFormat = pickVideoFormat(formats, height);
        JSONObject audioFormat = pickAudioFormat(formats);
        if (videoFormat == null || audioFormat == null)
            throw new IllegalArgumentException("No compatible download streams are available for this video.");
        final String videoFormatId = strOf(videoFormat, "format_id");
        final String audioFormatId = strOf(audioFormat, "format_id");
        if (videoFormatId.isEmpty() || audioFormatId.isEmpty())
            throw new IllegalArgumentException("No compatible download streams are available for this video.");
        long expectedVideo = sizeOf(videoFormat);
        long expectedAudio = sizeOf(audioFormat);
        long combined = expectedVideo + expectedAudio;
        long required = combined > 0 ? combined + combined / 4 : 256L * 1024 * 1024;
        long available = new android.os.StatFs(context.getNoBackupFilesDir().getPath()).getAvailableBytes();
        if (available < required) throw new IllegalArgumentException("Not enough storage. Free space and try again.");
        java.io.File directory = downloadsDirectory();
        String videoExtRaw = strOf(videoFormat, "ext").toLowerCase(Locale.ROOT);
        String audioExtRaw = strOf(audioFormat, "ext").toLowerCase(Locale.ROOT);
        final String videoExt = videoExtRaw.isEmpty() ? "mp4" : videoExtRaw;
        final String audioExt = audioExtRaw.isEmpty() ? "m4a" : audioExtRaw;
        int chosenHeight = intOf(videoFormat, "height", 0);
        if (chosenHeight <= 0 && height > 0) chosenHeight = height;
        final String label = chosenHeight > 0 ? chosenHeight + "p" : "video";
        synchronized (downloadGate) {
            if (downloadJobs.containsKey(id)) throw new IllegalArgumentException("This video is already downloading.");
            deleteDownloadMedia(directory, id);
            JSONObject meta = new JSONObject()
                    .put("id", id)
                    .put("height", chosenHeight)
                    .put("label", label)
                    .put("videoExt", videoExt)
                    .put("audioExt", audioExt)
                    .put("videoExpected", expectedVideo)
                    .put("audioExpected", expectedAudio)
                    .put("state", "downloading")
                    .put("startedAt", System.currentTimeMillis())
                    .put("error", JSONObject.NULL);
            writeTextAtomically(new java.io.File(directory, id + ".json"), meta.toString());
            final java.io.File folder = directory;
            FutureTask<Void> task = new FutureTask<>(() -> {
                runDownload(id, folder, videoFormatId, audioFormatId, videoExt, audioExt);
                return null;
            });
            downloadJobs.put(id, task);
            try {
                downloadPool.execute(task);
            } catch (java.util.concurrent.RejectedExecutionException rejected) {
                downloadJobs.remove(id);
                updateDownloadState(directory, id, "failed", "A few downloads are queued. Please try again in a moment.");
                throw new IllegalArgumentException("A few downloads are queued. Please try again in a moment.");
            }
        }
        return new JSONObject()
                .put("videoBytes", 0)
                .put("audioBytes", 0)
                .put("height", chosenHeight)
                .put("label", label)
                .put("videoExt", videoExt)
                .put("audioExt", audioExt)
                .put("state", "downloading");
    }

    // Video-only streams (separate audio), mirroring the online player's
    // separate-audio path. Prefer mp4, then webm; stay at or below the
    // requested height when possible (otherwise take the highest); prefer
    // hardware-friendly codecs for WebView, then bitrate.
    private static JSONObject pickVideoFormat(org.json.JSONArray formats, int requestedHeight) {
        java.util.List<JSONObject> video = new java.util.ArrayList<>();
        for (int i = 0; i < formats.length(); i++) {
            JSONObject format = formats.optJSONObject(i);
            if (format == null || !eligible(format)) continue;
            String vcodec = strOf(format, "vcodec");
            String acodec = strOf(format, "acodec");
            if (vcodec.isEmpty() || "none".equals(vcodec)) continue;
            if (!"none".equals(acodec)) continue;
            video.add(format);
        }
        if (video.isEmpty()) return null;
        java.util.List<JSONObject> mp4 = filterByExt(video, "mp4");
        java.util.List<JSONObject> webm = filterByExt(video, "webm");
        java.util.List<JSONObject> pool = !mp4.isEmpty() ? mp4 : !webm.isEmpty() ? webm : video;
        if (requestedHeight > 0) {
            java.util.List<JSONObject> within = new java.util.ArrayList<>();
            for (JSONObject format : pool) if (intOf(format, "height", 0) <= requestedHeight) within.add(format);
            if (!within.isEmpty()) pool = within;
        }
        int bestHeight = 0;
        for (JSONObject format : pool) bestHeight = Math.max(bestHeight, intOf(format, "height", 0));
        java.util.List<JSONObject> top = new java.util.ArrayList<>();
        for (JSONObject format : pool) if (intOf(format, "height", 0) == bestHeight) top.add(format);
        top.sort((a, b) -> {
            int rank = Integer.compare(codecRank(strOf(a, "vcodec")), codecRank(strOf(b, "vcodec")));
            return rank != 0 ? rank : Double.compare(doubleOf(b, "tbr"), doubleOf(a, "tbr"));
        });
        return top.get(0);
    }

    // Audio-only streams: prefer m4a, then webm/opus; best average bitrate wins.
    private static JSONObject pickAudioFormat(org.json.JSONArray formats) {
        java.util.List<JSONObject> audio = new java.util.ArrayList<>();
        for (int i = 0; i < formats.length(); i++) {
            JSONObject format = formats.optJSONObject(i);
            if (format == null || !eligible(format)) continue;
            String vcodec = strOf(format, "vcodec");
            String acodec = strOf(format, "acodec");
            if (acodec.isEmpty() || "none".equals(acodec)) continue;
            if (!"none".equals(vcodec)) continue;
            audio.add(format);
        }
        if (audio.isEmpty()) return null;
        java.util.List<JSONObject> m4a = filterByExt(audio, "m4a");
        java.util.List<JSONObject> webm = filterByExt(audio, "webm");
        java.util.List<JSONObject> pool = !m4a.isEmpty() ? m4a : !webm.isEmpty() ? webm : audio;
        pool.sort((a, b) -> Double.compare(doubleOf(b, "abr"), doubleOf(a, "abr")));
        return pool.get(0);
    }

    private static boolean eligible(JSONObject format) {
        return "https".equals(strOf(format, "protocol"))
                && !strOf(format, "url").isEmpty()
                && !"true".equalsIgnoreCase(strOf(format, "has_drm"));
    }

    private static java.util.List<JSONObject> filterByExt(java.util.List<JSONObject> formats, String ext) {
        java.util.List<JSONObject> out = new java.util.ArrayList<>();
        for (JSONObject format : formats) if (ext.equalsIgnoreCase(strOf(format, "ext"))) out.add(format);
        return out;
    }

    private static int codecRank(String vcodec) {
        String codec = vcodec.toLowerCase(Locale.ROOT);
        if (codec.startsWith("avc1") || codec.startsWith("avc3")) return 0;
        if (codec.startsWith("vp9") || codec.startsWith("vp09")) return 1;
        if (codec.startsWith("av01")) return 2;
        return 3;
    }

    private static String strOf(JSONObject object, String key) {
        Object value = object.opt(key);
        return value == null || value == JSONObject.NULL ? "" : String.valueOf(value).trim();
    }

    private static int intOf(JSONObject object, String key, int fallback) {
        Object value = object.opt(key);
        if (value instanceof Number) return ((Number) value).intValue();
        try { return Integer.parseInt(String.valueOf(value).trim()); }
        catch (Exception ignored) {
            try { return (int) Double.parseDouble(String.valueOf(value).trim()); }
            catch (Exception ignoredAgain) { return fallback; }
        }
    }

    private static double doubleOf(JSONObject object, String key) {
        Object value = object.opt(key);
        if (value instanceof Number) return ((Number) value).doubleValue();
        try { return Double.parseDouble(String.valueOf(value).trim()); } catch (Exception ignored) { return 0; }
    }

    private static long longOf(JSONObject object, String key, long fallback) {
        Object value = object.opt(key);
        if (value instanceof Number) return ((Number) value).longValue();
        try { return Long.parseLong(String.valueOf(value).trim()); } catch (Exception ignored) { return fallback; }
    }

    private static long sizeOf(JSONObject format) {
        for (String key : new String[]{"filesize", "filesize_approx"}) {
            Object value = format.opt(key);
            if (value instanceof Number) {
                long size = ((Number) value).longValue();
                if (size > 0) return size;
            } else if (value != null && value != JSONObject.NULL) {
                try {
                    double size = Double.parseDouble(String.valueOf(value).trim());
                    if (size > 0) return (long) size;
                } catch (Exception ignored) { }
            }
        }
        return 0;
    }

    private java.io.File downloadsDirectory() {
        java.io.File directory = new java.io.File(context.getNoBackupFilesDir(), "downloads");
        if (!directory.isDirectory() && !directory.mkdirs())
            throw new IllegalArgumentException("Could not create the downloads folder.");
        return directory;
    }

    private java.io.File downloadsDirectoryOrNull() {
        java.io.File directory = new java.io.File(context.getNoBackupFilesDir(), "downloads");
        return directory.isDirectory() ? directory : null;
    }

    private static java.io.File findDownloadFile(java.io.File directory, String id, String kind) {
        java.io.File[] files = directory.listFiles();
        if (files == null) return null;
        String prefix = id + "." + kind + ".";
        for (java.io.File file : files) if (file.isFile() && file.getName().startsWith(prefix)) return file;
        return null;
    }

    private static long fileLength(java.io.File file) {
        return file != null && file.isFile() ? file.length() : 0;
    }

    private void runDownload(String id, java.io.File directory, String videoFormatId, String audioFormatId,
                             String videoExt, String audioExt) {
        try {
            prepareRuntime();
            executeDownload(id, videoFormatId, new java.io.File(directory, id + ".video." + videoExt));
            executeDownload(id, audioFormatId, new java.io.File(directory, id + ".audio." + audioExt));
            java.io.File videoFile = new java.io.File(directory, id + ".video." + videoExt);
            java.io.File audioFile = new java.io.File(directory, id + ".audio." + audioExt);
            if (!videoFile.isFile() || videoFile.length() == 0)
                throw new IllegalStateException("The video could not be downloaded. Check your connection and retry.");
            if (!audioFile.isFile() || audioFile.length() == 0)
                throw new IllegalStateException("The audio track could not be downloaded. Check your connection and retry.");
            updateDownloadState(directory, id, "done", null);
        } catch (Exception error) {
            String message = Thread.currentThread().isInterrupted()
                    ? "The download was interrupted."
                    : error instanceof IllegalArgumentException || error instanceof IllegalStateException
                        ? error.getMessage()
                        : friendly(error);
            if (message == null || message.isEmpty() || "null".equalsIgnoreCase(message))
                message = "Could not finish the download. Check your Wi-Fi and retry.";
            if (message.length() > 140) message = message.substring(0, 140);
            updateDownloadState(directory, id, "failed", message);
        } finally {
            downloadJobs.remove(id);
        }
    }

    private void executeDownload(String id, String formatId, java.io.File output) throws Exception {
        YoutubeDLRequest request = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
        request.addOption("--ignore-config");
        request.addOption("--no-warnings");
        request.addOption("--no-playlist");
        request.addOption("-f", formatId);
        request.addOption("--no-part");
        request.addOption("-o", output.getPath());
        request.addOption("-q");
        request.addOption("--retries", "2");
        request.addOption("--socket-timeout", "12");
        request.addOption("--user-agent", USER_AGENT);
        // stdout carries nothing useful for a file transfer; completion is all we need.
        YoutubeDL.getInstance().execute(request, "dinosour-dl-" + id, null);
    }

    private JSONObject downloadStat(String id) throws Exception {
        if (!id.matches("[A-Za-z0-9_-]{11}")) throw new IllegalArgumentException("Invalid video ID.");
        java.io.File directory = downloadsDirectoryOrNull();
        java.io.File metaFile = directory == null ? null : new java.io.File(directory, id + ".json");
        if (metaFile == null || !metaFile.isFile()) return new JSONObject().put("state", "missing");
        JSONObject meta = new JSONObject(new String(read(new java.io.FileInputStream(metaFile), 1024 * 1024), StandardCharsets.UTF_8));
        long videoBytes = fileLength(findDownloadFile(directory, id, "video"));
        long audioBytes = fileLength(findDownloadFile(directory, id, "audio"));
        long videoExpected = longOf(meta, "videoExpected", 0);
        long audioExpected = longOf(meta, "audioExpected", 0);
        long expected = videoExpected + audioExpected;
        long received = videoBytes + audioBytes;
        String state = strOf(meta, "state");
        if (state.isEmpty()) state = "unknown";
        boolean done = "done".equals(state);
        Object error = meta.isNull("error") ? JSONObject.NULL : meta.opt("error");
        if (error == null) error = JSONObject.NULL;
        Object progress;
        if (done) progress = 1;
        else if (expected > 0) progress = Math.min(1.0, (double) received / expected);
        else progress = JSONObject.NULL;
        return new JSONObject()
                .put("id", id)
                .put("state", state)
                .put("error", error)
                .put("videoBytes", videoBytes)
                .put("audioBytes", audioBytes)
                .put("videoExpected", videoExpected)
                .put("audioExpected", audioExpected)
                .put("videoDone", done && videoBytes > 0)
                .put("audioDone", done && audioBytes > 0)
                .put("progress", progress);
    }

    private void removeDownload(String id) throws Exception {
        if (!id.matches("[A-Za-z0-9_-]{11}")) throw new IllegalArgumentException("Invalid video ID.");
        YoutubeDL.getInstance().destroyProcessById("dinosour-dl-" + id);
        FutureTask<Void> task = downloadJobs.remove(id);
        if (task != null) task.cancel(true);
        deleteDownloadFiles(downloadsDirectoryOrNull(), id);
    }

    private static JSONObject okResult() throws Exception {
        return new JSONObject().put("ok", true);
    }

    private static void deleteDownloadMedia(java.io.File directory, String id) {
        if (directory == null) return;
        java.io.File[] files = directory.listFiles();
        if (files == null) return;
        String video = id + ".video.", audio = id + ".audio.";
        for (java.io.File file : files) {
            String name = file.getName();
            if (file.isFile() && (name.startsWith(video) || name.startsWith(audio))) file.delete();
        }
    }

    private static void deleteDownloadFiles(java.io.File directory, String id) {
        if (directory == null) return;
        deleteDownloadMedia(directory, id);
        for (String name : new String[]{id + ".json", id + ".json.tmp"}) {
            java.io.File file = new java.io.File(directory, name);
            if (file.isFile()) file.delete();
        }
    }

    // Only rewrites the meta while it still exists and is mid-flight, so a
    // cancel/delete racing with the transfer thread is never resurrected.
    private void updateDownloadState(java.io.File directory, String id, String state, String error) {
        try {
            java.io.File metaFile = new java.io.File(directory, id + ".json");
            if (!metaFile.isFile()) return;
            JSONObject meta = new JSONObject(new String(read(new java.io.FileInputStream(metaFile), 1024 * 1024), StandardCharsets.UTF_8));
            if (!"downloading".equals(strOf(meta, "state"))) return;
            meta.put("state", state);
            meta.put("error", error == null ? JSONObject.NULL : error);
            writeTextAtomically(metaFile, meta.toString());
        } catch (Exception ignored) { }
    }

    private static void writeTextAtomically(java.io.File target, String text) throws Exception {
        java.io.File temporary = new java.io.File(target.getParentFile(), target.getName() + ".tmp");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(temporary)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!temporary.renameTo(target)) {
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(target)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!temporary.delete()) temporary.deleteOnExit();
        }
    }

    // Streams a downloaded file to the WebView with HTTP range support so the
    // offline player can seek without loading the whole file into memory.
    WebResourceResponse fileRange(String id, String kind, String rangeHeader) {
        try {
            if (!id.matches("[A-Za-z0-9_-]{11}")) return empty(404);
            if (!"video".equals(kind) && !"audio".equals(kind)) return empty(404);
            java.io.File directory = downloadsDirectoryOrNull();
            java.io.File file = directory == null ? null : findDownloadFile(directory, id, kind);
            if (file == null || !file.isFile()) return empty(404);
            long size = file.length();
            if (size <= 0) return empty(404);
            String mime = downloadMime(file.getName(), kind);
            long start = 0, end = size - 1;
            boolean partial = false;
            if (rangeHeader != null && !rangeHeader.trim().isEmpty()) {
                java.util.regex.Matcher matcher =
                        java.util.regex.Pattern.compile("^bytes=([0-9]*)-([0-9]*)$").matcher(rangeHeader.trim());
                if (!matcher.matches()) return rangeNotSatisfiable(size);
                String first = matcher.group(1), last = matcher.group(2);
                if (first.isEmpty() && last.isEmpty()) return rangeNotSatisfiable(size);
                if (first.isEmpty()) {
                    long suffix = longSaturating(last);
                    if (suffix <= 0) return rangeNotSatisfiable(size);
                    start = Math.max(0, size - suffix);
                    end = size - 1;
                } else {
                    start = longSaturating(first);
                    end = last.isEmpty() ? size - 1 : Math.min(longSaturating(last), size - 1);
                    if (start >= size || start > end) return rangeNotSatisfiable(size);
                }
                partial = true;
            }
            if (!partial) {
                return new WebResourceResponse(mime, null, 200, "OK",
                        rangeHeaders(size, null), new java.io.FileInputStream(file));
            }
            java.io.FileInputStream raw = new java.io.FileInputStream(file);
            long position = 0;
            while (position < start) {
                long skipped = raw.skip(start - position);
                if (skipped <= 0) {
                    try { raw.close(); } catch (java.io.IOException ignored) { }
                    return empty(404);
                }
                position += skipped;
            }
            long length = end - start + 1;
            return new WebResourceResponse(mime, null, 206, "Partial Content",
                    rangeHeaders(length, "bytes " + start + "-" + end + "/" + size),
                    new BoundedInputStream(raw, length));
        } catch (Exception error) {
            return empty(404);
        }
    }

    private static WebResourceResponse rangeNotSatisfiable(long size) {
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Content-Range", "bytes */" + size);
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "private, no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 416, "Range Not Satisfiable",
                headers, new ByteArrayInputStream(new byte[0]));
    }

    private static java.util.Map<String, String> rangeHeaders(long contentLength, String contentRange) {
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Content-Length", String.valueOf(contentLength));
        if (contentRange != null) headers.put("Content-Range", contentRange);
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "private, no-store");
        return headers;
    }

    private static String downloadMime(String fileName, String kind) {
        String name = fileName.toLowerCase(Locale.ROOT);
        boolean video = "video".equals(kind);
        if (name.endsWith(".mp4")) return video ? "video/mp4" : "audio/mp4";
        if (name.endsWith(".webm")) return video ? "video/webm" : "audio/webm";
        if (name.endsWith(".mkv")) return video ? "video/x-matroska" : "audio/x-matroska";
        if (name.endsWith(".m4a")) return "audio/mp4";
        return video ? "video/mp4" : "audio/mp4";
    }

    private static long longSaturating(String digits) {
        try {
            return Long.parseLong(digits);
        } catch (NumberFormatException overflow) {
            return Long.MAX_VALUE;
        }
    }

    private static final class BoundedInputStream extends InputStream {
        private final InputStream source;
        private long remaining;

        private BoundedInputStream(InputStream source, long length) {
            this.source = source;
            this.remaining = length;
        }

        @Override public int read() throws java.io.IOException {
            if (remaining <= 0) return -1;
            int value = source.read();
            if (value != -1) remaining--;
            return value;
        }

        @Override public int read(byte[] buffer, int offset, int length) throws java.io.IOException {
            if (remaining <= 0) return -1;
            int count = source.read(buffer, offset, (int) Math.min(length, remaining));
            if (count > 0) remaining -= count;
            return count;
        }

        @Override public long skip(long count) throws java.io.IOException {
            long skipped = source.skip(Math.min(count, remaining));
            remaining -= skipped;
            return skipped;
        }

        @Override public int available() throws java.io.IOException {
            return (int) Math.min(remaining, Integer.MAX_VALUE);
        }

        @Override public void close() throws java.io.IOException {
            source.close();
        }
    }
}
