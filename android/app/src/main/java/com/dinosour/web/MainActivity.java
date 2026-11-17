package com.dinosour.web;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final String PREFS = "dinosour";
    private static final String KEY_SERVER = "server_url";
    private static final int BG = Color.rgb(15, 15, 15);
    private static final int ACCENT = Color.rgb(255, 0, 51);

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView webView;
    private ProgressBar progress;
    private LinearLayout errorView;
    private TextView errorDetail;
    private DinosourChromeClient chromeClient;
    private String serverUrl;
    private boolean loadFailed;
    private long updateDownloadId = -1;
    private BroadcastReceiver downloadReceiver;
    private NativeEngine engine;
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private String pendingBackup;
    private static final int OPEN_BACKUP = 501, SAVE_BACKUP = 502, REQUEST_NOTIFICATIONS = 503;
    private static final String[] STORAGE_KEYS = {"dinosour.library.v1", "dinosour.ui.v1"};
    // The page can be buggy or compromised; never let multi-megabyte strings
    // reach native code. 32 MB still fits a legitimate multi-MB library backup.
    private static final int MAX_STORED_DATA = 32 * 1024 * 1024;
    // NativeEngine expects ids like "1700000000000-1" (<= 22 chars).
    private static final int MAX_REQUEST_ID = 64;
    private static final int MAX_REQUEST_KIND = 32;
    // Matches NativeEngine.request's own 100,000-char ceiling.
    private static final int MAX_REQUEST_PAYLOAD = 100_000;
    private LinearLayout startupView;
    private final android.os.Handler startupHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean startupReady, rendererGone;
    private boolean notificationPromptRequested;
    private boolean backgroundPlaying, backgroundServiceRunning;
    private final Runnable startupTimeout = () -> {
        if (!startupReady && !loadFailed && !isFinishing() && !isDestroyed())
            showError("The app interface did not finish starting. Tap Try again. If it happens again, update Android System WebView using the button below.");
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String previousServer = prefs.getString(KEY_SERVER, null);
        serverUrl = Config.APP_ORIGIN;
        setupWindow();
        buildLayout();
        engine = new NativeEngine(this, (id, payload) -> runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed() && webView != null)
                webView.evaluateJavascript("window.__dinosourNativeResult && window.__dinosourNativeResult(" +
                        JSONObject.quote(id) + "," + payload.toString() + ");", null);
        }));
        registerDownloadReceiver();
        migrateStorage(previousServer);
    }

    private void setupWindow() {
        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildLayout() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        webView = new WebView(this);
        webView.setBackgroundColor(BG);
        webView.setVisibility(View.VISIBLE);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setUserAgentString(NativeEngine.USER_AGENT);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.addJavascriptInterface(new AndroidBridge(), "DinosourAndroid");

        chromeClient = new DinosourChromeClient();
        webView.setWebViewClient(new DinosourClient());
        webView.setWebChromeClient(chromeClient);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(ColorStateList.valueOf(ACCENT));
        progress.setBackgroundColor(Color.TRANSPARENT);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        root.addView(progress, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2), Gravity.TOP));

        startupView = new LinearLayout(this);
        startupView.setOrientation(LinearLayout.VERTICAL);
        startupView.setGravity(Gravity.CENTER);
        startupView.setBackgroundColor(BG);
        startupView.setPadding(dp(28), dp(28), dp(28), dp(28));
        TextView startupTitle = new TextView(this);
        startupTitle.setText("Dinosour");
        startupTitle.setTextColor(Color.WHITE);
        startupTitle.setTextSize(28);
        startupView.addView(startupTitle);
        TextView startupText = new TextView(this);
        startupText.setText("Opening your videos…");
        startupText.setTextColor(Color.LTGRAY);
        startupText.setTextSize(16);
        startupText.setPadding(0, dp(12), 0, dp(24));
        startupView.addView(startupText);
        startupView.addView(new ProgressBar(this));
        // The overlay is an opaque spinner with no other escape; tapping it
        // reloads the page if the interface stalls.
        startupView.setContentDescription("Reload");
        startupView.setOnClickListener(v -> { if (webView != null) webView.reload(); });
        root.addView(startupView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        buildErrorView();
        setContentView(root);
    }

    private void buildErrorView() {
        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setGravity(Gravity.CENTER);
        errorView.setBackgroundColor(BG);
        errorView.setPadding(dp(28), dp(28), dp(28), dp(28));
        errorView.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText("Couldn't open Dinosour");
        title.setTextColor(Color.WHITE);
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        errorView.addView(title);

        errorDetail = new TextView(this);
        errorDetail.setTextColor(Color.rgb(170, 170, 170));
        errorDetail.setTextSize(14);
        errorDetail.setGravity(Gravity.CENTER);
        errorDetail.setPadding(0, dp(12), 0, dp(24));
        errorView.addView(errorDetail);

        TextView hint = new TextView(this);
        hint.setText("Dinosour runs on this phone. Retrying or updating WebView does not erase your library.");
        hint.setTextColor(Color.rgb(170, 170, 170));
        hint.setTextSize(13);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 0, 0, dp(24));
        errorView.addView(hint);

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(v -> {
            if (rendererGone) recreate();
            else loadServer();
        });
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryParams.bottomMargin = dp(8);
        errorView.addView(retry, retryParams);

        Button settings = new Button(this);
        settings.setText("App settings");
        settings.setOnClickListener(v -> showSettings(false));
        errorView.addView(settings);
        Button updateWebView = new Button(this);
        updateWebView.setText("Update Android WebView");
        updateWebView.setOnClickListener(v -> openWebViewUpdate());
        errorView.addView(updateWebView);

        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private String normalizeServer(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        try {
            Uri uri = Uri.parse(value);
            String scheme = uri.getScheme();
            if (!("http".equals(scheme) || "https".equals(scheme)) || uri.getHost() == null) return null;
            return value;
        } catch (Exception error) {
            return null;
        }
    }

    private void loadServer() {
        if (webView == null) { recreate(); return; }
        loadFailed = false;
        startupReady = false;
        hideError();
        startupView.setVisibility(View.VISIBLE);
        progress.setIndeterminate(true);
        progress.setVisibility(View.VISIBLE);
        // An invisible WebView can delay rendering callbacks on some phones.
        // Keep it mounted and visible; the native startup view covers it.
        webView.setVisibility(View.VISIBLE);
        webView.stopLoading();
        startupHandler.removeCallbacks(startupTimeout);
        startupHandler.postDelayed(startupTimeout, 15000);
        String home = Config.APP_ORIGIN + "/#home";
        if (home.equals(webView.getUrl())) webView.reload();
        else webView.loadUrl(home);
    }

    private void interfaceReady() {
        if (loadFailed || isFinishing() || isDestroyed() || webView == null) return;
        startupReady = true;
        startupHandler.removeCallbacks(startupTimeout);
        startupView.setVisibility(View.GONE);
        hideError();
        progress.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        requestNotificationsIfReady();
    }

    // Android 13+ requires a runtime grant before ANY app notification
    // appears; without this ask, the background-audio notification and its
    // lock-screen controls never render. Declines are respected (the app
    // stays silent, which is a valid choice). Deferred until the interface is
    // ready so the prompt does not delay cold start; fires at most once.
    private void requestNotificationsIfReady() {
        if (notificationPromptRequested) return;
        notificationPromptRequested = true;
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                        android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATIONS);
        }
    }

    private void showError(String detail) {
        loadFailed = true;
        startupHandler.removeCallbacks(startupTimeout);
        startupView.setVisibility(View.GONE);
        String version = "Dinosour " + BuildConfig.VERSION_NAME;
        if (Build.VERSION.SDK_INT >= 26) {
            android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
            if (provider != null) version += "\n" + provider.packageName + " " + provider.versionName;
        }
        errorDetail.setText(detail + "\n\n" + version);
        errorView.setVisibility(View.VISIBLE);
        if (webView != null) webView.setVisibility(View.INVISIBLE);
        progress.setVisibility(View.GONE);
    }

    private void openWebViewUpdate() {
        String providerName = "com.google.android.webview";
        if (Build.VERSION.SDK_INT >= 26) {
            android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
            if (provider != null) providerName = provider.packageName;
        }
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + providerName))); }
        catch (Exception error) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + providerName))); }
            catch (Exception ignored) { toast("Update Android System WebView or Chrome in your app store."); }
        }
    }

    // The interface reports playback start/stop through the bridge. While
    // playing, a foreground service keeps audio alive outside the app; the
    // notification's Play/Pause button toggles the actual media element.
    private void updateBackgroundAudio(boolean playing, String title) {
        backgroundPlaying = playing;
        BackgroundAudioService.playing = playing;
        BackgroundAudioService.title = title == null ? "" : title;
        if (playing) {
            if (!backgroundServiceRunning) {
                try {
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(new Intent(this, BackgroundAudioService.class));
                    else startService(new Intent(this, BackgroundAudioService.class));
                    backgroundServiceRunning = true;
                } catch (Exception error) { backgroundServiceRunning = false; }
            }
        } else if (backgroundServiceRunning) {
            backgroundServiceRunning = false;
            stopService(new Intent(this, BackgroundAudioService.class));
        }
        if (backgroundServiceRunning) {
            try { startService(new Intent(this, BackgroundAudioService.class)
                    .setAction(BackgroundAudioService.ACTION_REFRESH)); }
            catch (Exception ignored) { }
        }
        BackgroundAudioService.toggleControls = () -> runOnUiThread(() -> webView.evaluateJavascript(
                "(function(){var v=document.getElementById('video');if(!v)return;if(v.paused){v.play()}else{v.pause()}})()", null));
    }

    private void hideError() {
        errorView.setVisibility(View.GONE);
    }

    private void showSettings(boolean firstRun) {
        new AlertDialog.Builder(this)
                .setTitle("Dinosour " + BuildConfig.VERSION_NAME)
                .setMessage("Playback runs on this phone using Wi-Fi or mobile data.\n\nNo computer, server address, access code, or account is needed.\n\nYour saved videos, topics, and history stay on this device.")
                .setPositiveButton("Done", null)
                .setNeutralButton("Check for updates", (d, w) -> checkForUpdates(Config.UPDATE_ORIGIN))
                .show();
    }

    // loadDataWithBaseURL restores the old origin without contacting the old
    // computer/tunnel. Read only our two keys; keep the original storage intact.
    private void migrateStorage(String previousServer) {
        // Fresh installs lack the legacy key entirely; skip the second
        // WebView (and its 2500ms grace delay) and continue immediately.
        if (!prefs.contains(KEY_SERVER) || prefs.getBoolean("standalone_migrated", false) || previousServer == null ||
                Config.APP_ORIGIN.equals(previousServer)) {
            loadServer();
            return;
        }
        String normalized = normalizeServer(previousServer);
        if (normalized == null) { loadServer(); return; }
        Uri uri = Uri.parse(normalized);
        String origin = uri.getScheme() + "://" + uri.getAuthority() + "/";
        WebView legacy = new WebView(this);
        legacy.getSettings().setJavaScriptEnabled(true);
        legacy.getSettings().setDomStorageEnabled(true);
        java.util.concurrent.atomic.AtomicBoolean finished = new java.util.concurrent.atomic.AtomicBoolean();
        Runnable finish = () -> {
            if (!finished.compareAndSet(false, true)) return;
            legacy.destroy();
            if (!isFinishing() && !isDestroyed()) loadServer();
        };
        legacy.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript("(function(){var v={};['dinosour.library.v1','dinosour.ui.v1'].forEach(function(k){v[k]=localStorage.getItem(k)});return v})()", value -> {
                    if (finished.get()) return;
                    try {
                        JSONObject old = new JSONObject(value);
                        SharedPreferences.Editor editor = prefs.edit();
                        for (String key : STORAGE_KEYS) {
                            if (!old.isNull(key) && !prefs.contains("web." + key)) editor.putString("web." + key, old.getString(key));
                        }
                        editor.putBoolean("standalone_migrated", true).apply();
                    } catch (Exception ignored) { }
                    finish.run();
                });
            }
        });
        legacy.loadDataWithBaseURL(origin, "<!doctype html><title>Restore library</title>", "text/html", "UTF-8", null);
        new android.os.Handler(getMainLooper()).postDelayed(finish, 2500);
    }

    private void checkForUpdates(String base) {
        if (base == null) {
            toast("Connect to a server first.");
            return;
        }
        toast("Checking for updates…");
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL endpoint = new URL(base + "/app-update.json?t=" + System.currentTimeMillis());
                connection = (HttpURLConnection) endpoint.openConnection();
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("Accept", "application/json");
                if (connection.getResponseCode() != 200) throw new Exception("HTTP " + connection.getResponseCode());
                StringBuilder body = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }
                JSONObject json = new JSONObject(body.toString());
                int versionCode = json.optInt("versionCode", 0);
                String versionName = json.optString("versionName", "");
                String apkUrl = json.optString("apkUrl", "");
                String notes = json.optString("notes", "");
                runOnUiThread(() -> {
                    if (versionCode <= BuildConfig.VERSION_CODE) {
                        toast("Dinosour is up to date (" + BuildConfig.VERSION_NAME + ").");
                    } else if (apkUrl.isEmpty()) {
                        toast("Version " + versionName + " is available, but its APK is not published yet.");
                    } else {
                        showUpdateDialog(base, versionName, notes, apkUrl);
                    }
                });
            } catch (Exception error) {
                runOnUiThread(() -> toast("Could not check for updates. Check the server address and try again."));
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private void showUpdateDialog(String base, String versionName, String notes, String apkUrl) {
        String message = notes == null || notes.isEmpty() ? "A newer version of Dinosour is available." : notes;
        new AlertDialog.Builder(this)
                .setTitle("Update to " + versionName)
                .setMessage(message)
                .setPositiveButton("Download", (d, w) -> downloadUpdate(base, versionName, apkUrl))
                .setNegativeButton("Later", null)
                .show();
    }

    private void downloadUpdate(String base, String versionName, String apkUrl) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle("Allow app installs")
                    .setMessage("Android needs permission to install Dinosour updates from this app. Turn on \"Allow from this source\" for Dinosour, then try again.")
                    .setPositiveButton("Open settings", (d, w) -> {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()));
                        try {
                            startActivity(intent);
                        } catch (Exception ignored) {
                        }
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
            return;
        }
        try {
            String resolved = new URL(new URL(base + "/"), apkUrl).toString();
            String safeVersion = versionName.replaceAll("[^A-Za-z0-9._-]", "_");
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(resolved));
            request.setTitle("Dinosour " + versionName);
            request.setDescription("Downloading the update…");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, "dinosour-" + safeVersion + ".apk");
            updateDownloadId = manager.enqueue(request);
            toast("Downloading update…");
        } catch (Exception error) {
            toast("Could not start the update download.");
        }
    }

    private void registerDownloadReceiver() {
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != updateDownloadId) return;
                DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                Uri uri = manager.getUriForDownloadedFile(id);
                if (uri == null) {
                    toast("The update download failed.");
                    return;
                }
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.setClipData(ClipData.newRawUri("", uri));
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    startActivity(install);
                } catch (Exception error) {
                    toast("Open the downloaded update from your Downloads notification.");
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
        else registerReceiver(downloadReceiver, filter);
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }

    private class DinosourClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost())) return null;
            String path = uri.getPath();
            if (path == null || path.contains("..") || path.contains("\\")) return NativeEngine.empty(404);
            // Offline downloads are served from no-backup files; GET/HEAD only.
            if (path.startsWith("/dl/")) {
                String[] parts = path.split("/");
                String method = request.getMethod();
                if (parts.length == 4 && ("GET".equals(method) || "HEAD".equals(method))) {
                    String dlId = parts[2], kind = parts[3];
                    if (dlId.matches("[A-Za-z0-9_-]{11}") && ("video".equals(kind) || "audio".equals(kind)) && engine != null) {
                        try { return engine.fileRange(dlId, kind, request.getRequestHeaders().get("Range")); }
                        catch (Exception ignored) { return NativeEngine.empty(404); }
                    }
                }
                return NativeEngine.empty(404);
            }
            if (path.startsWith("/api/thumb/")) return engine.thumbnail(path.substring("/api/thumb/".length()), "short".equals(uri.getQueryParameter("t")));
            String asset = path.equals("/") ? "index.html" : path.substring(1);
            String mime = asset.endsWith(".html") ? "text/html" :
                    asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" :
                    asset.endsWith(".svg") ? "image/svg+xml" : asset.endsWith(".png") ? "image/png" :
                    asset.endsWith(".webmanifest") ? "application/manifest+json" :
                    asset.endsWith(".json") ? "application/json" : "text/plain";
            try {
                java.util.Map<String, String> headers = new java.util.HashMap<>();
                headers.put("Cache-Control", "no-cache");
                headers.put("X-Content-Type-Options", "nosniff");
                return new WebResourceResponse(mime, mime.startsWith("image/") ? null : "UTF-8",
                        200, "OK", headers, getAssets().open(asset));
            } catch (Exception error) { return NativeEngine.empty(404); }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())) return false;
            // Only override well-known web/mailto/market URLs. Anything else stays inside
            // the app and is blocked, so no exotic intent handlers fire by accident.
            String scheme = uri.getScheme();
            if (!"https".equals(scheme) && !"http".equals(scheme) && !"market".equals(scheme) && !"mailto".equals(scheme) && !"tel".equals(scheme)) return true;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (!loadFailed) progress.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!loadFailed) {
                webView.setVisibility(View.VISIBLE);
                // Do not wait for thumbnails/network requests before revealing
                // the app. appReady() normally arrives before onPageFinished.
                view.evaluateJavascript("window.__dinosourReady === true", value -> {
                    if ("true".equals(value)) interfaceReady();
                });
                    }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            rendererGone = true;
            chromeClient.hideCustomView();
            root.removeView(view);
            view.destroy();
            if (webView == view) webView = null;
            showError("Android stopped the page renderer. Tap Try again to reopen Dinosour.");
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                String description = error.getDescription() == null ? "" : error.getDescription().toString();
                showError("Could not open Dinosour.\n" + description + "\n\nTry reopening the app.");
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 400) {
                showError("Dinosour could not load this page. Try again.");
            }
        }
    }

    private class DinosourChromeClient extends WebChromeClient {
        private View customView;
        private CustomViewCallback customViewCallback;

        @Override
        public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json");
            try { startActivityForResult(intent, OPEN_BACKUP); }
            catch (Exception error) { fileCallback.onReceiveValue(null); fileCallback = null; toast("No file picker is available."); }
            return true;
        }

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setIndeterminate(false);
            progress.setProgress(newProgress);
            progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            customView.setBackgroundColor(Color.BLACK);
            root.addView(customView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            // INVISIBLE, not GONE: the custom view already paints black, and some
            // OEM WebView builds tear down the video surface when the WebView is
            // GONE — producing a black frame and a cold rebuffer on exit-fullscreen.
            webView.setVisibility(View.INVISIBLE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }

        @Override
        public void onHideCustomView() {
            hideCustomView();
        }

        void hideCustomView() {
            if (customView == null) return;
            root.removeView(customView);
            customView = null;
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            if (webView != null) webView.setVisibility(errorView.getVisibility() == View.VISIBLE ? View.INVISIBLE : View.VISIBLE);
            if (customViewCallback != null) {
                customViewCallback.onCustomViewHidden();
                customViewCallback = null;
            }
        }
    }

    // Only the bundled app origin may use the bridge. WebView.getUrl() returns
    // null for pages loaded from raw HTML strings (loadDataWithBaseURL) on some
    // Android versions, so a null URL is treated as the bundled app origin rather
    // than a foreign page; a non-null URL must at minimum start with our own
    // origin. Foreign pages still cannot reach the bridge.
    private boolean isAppOrigin() {
        if (webView == null) return false;
        String url;
        try { url = webView.getUrl(); } catch (Throwable ignored) { url = null; }
        if (url == null || url.isEmpty()) return true;
        return url.startsWith(Config.APP_ORIGIN);
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void appReady() {
            if (!isAppOrigin()) return;
            runOnUiThread(() -> interfaceReady());
        }

        @JavascriptInterface
        public void startupFailed(String message) {
            if (!isAppOrigin()) return;
            final String detail = message == null ? "The interface could not start." : message.substring(0, Math.min(message.length(), 400));
            runOnUiThread(() -> {
                if (!startupReady && !isFinishing() && !isDestroyed())
                    showError("The interface could not start. Try again or update Android System WebView.\n\n" + detail);
            });
        }

        @JavascriptInterface
        public void exportBackup(String data) {
            if (!isAppOrigin()) return;
            if (data == null || data.length() > MAX_STORED_DATA) return;
            runOnUiThread(() -> {
                pendingBackup = data;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_TITLE, "dinosour-backup.json");
                try { startActivityForResult(intent, SAVE_BACKUP); }
                catch (Exception error) { pendingBackup = null; toast("Could not open the file picker."); }
            });
        }
        @JavascriptInterface
        public void nativeRequest(String id, String kind, String payload) {
            if (!isAppOrigin()) return;
            if (id == null || kind == null || payload == null ||
                    id.length() > MAX_REQUEST_ID || kind.length() > MAX_REQUEST_KIND ||
                    payload.length() > MAX_REQUEST_PAYLOAD) {
                replyNativeError(id, "The request is too large or invalid.");
                return;
            }
            if (engine != null) engine.request(id, kind, payload);
        }

        @JavascriptInterface
        public void cancelRequest(String id) {
            if (!isAppOrigin()) return;
            if (id == null || id.length() > MAX_REQUEST_ID) return;
            if (engine != null) engine.cancel(id);
        }

        @JavascriptInterface
        public String readStorage() {
            if (!isAppOrigin()) return "{}";
            JSONObject result = new JSONObject();
            try {
                for (String key : STORAGE_KEYS) if (prefs.contains("web." + key)) result.put(key, prefs.getString("web." + key, ""));
            } catch (Exception ignored) { }
            return result.toString();
        }

        @JavascriptInterface
        public void saveStorage(String key, String value) {
            if (!isAppOrigin()) return;
            if (!java.util.Arrays.asList(STORAGE_KEYS).contains(key) || value == null || value.length() > MAX_STORED_DATA) return;
            if (value.isEmpty()) prefs.edit().remove("web." + key).apply();
            else prefs.edit().putString("web." + key, value).apply();
        }

        @JavascriptInterface
        public void openSettings() {
            if (!isAppOrigin()) return;
            runOnUiThread(() -> showSettings(false));
        }

        @JavascriptInterface
        public void backgroundAudio(boolean playing, String title) {
            if (!isAppOrigin()) return;
            runOnUiThread(() -> updateBackgroundAudio(playing, title));
        }

        @JavascriptInterface
        public void checkForUpdates() {
            if (!isAppOrigin()) return;
            runOnUiThread(() -> MainActivity.this.checkForUpdates(Config.UPDATE_ORIGIN));
        }

        @JavascriptInterface
        public String versionName() {
            if (!isAppOrigin()) return "unknown";
            return BuildConfig.VERSION_NAME;
        }
    }

    // Mirrors the NativeEngine callback shape so the page gets an error
    // instead of a hung promise when a request is rejected at the bridge.
    private void replyNativeError(String id, String message) {
        final String safeId = id == null ? "" : id.substring(0, Math.min(id.length(), MAX_REQUEST_ID));
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || webView == null) return;
            try {
                JSONObject payload = new JSONObject().put("ok", false).put("error", message);
                webView.evaluateJavascript("window.__dinosourNativeResult && window.__dinosourNativeResult(" +
                        JSONObject.quote(safeId) + "," + payload + ");", null);
            } catch (Exception ignored) { }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == OPEN_BACKUP && fileCallback != null) {
            fileCallback.onReceiveValue(resultCode == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null);
            fileCallback = null;
        } else if (requestCode == SAVE_BACKUP) {
            String backup = pendingBackup;
            pendingBackup = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || backup == null) return;
            Uri destination = data.getData();
            new Thread(() -> {
                try (java.io.OutputStream out = getContentResolver().openOutputStream(destination)) {
                    if (out == null) throw new java.io.IOException("No destination");
                    out.write(backup.getBytes(StandardCharsets.UTF_8));
                    runOnUiThread(() -> toast("Backup saved."));
                } catch (Exception error) { runOnUiThread(() -> toast("Could not save the backup.")); }
            }).start();
        }
    }

    @Override
    public void onBackPressed() {
        if (chromeClient.customView != null) {
            chromeClient.hideCustomView();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        // Do not call webView.onPause(): it suspends the media pipeline and
        // timers, and several WebView builds fail to re-prime buffers on
        // resume — the page looks "stuck loading" after a notification shade
        // or split-screen round-trip. The foreground service handles battery;
        // nothing here should suspend playback.
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        startupHandler.removeCallbacksAndMessages(null);
        if (backgroundServiceRunning) {
            backgroundServiceRunning = false;
            stopService(new Intent(this, BackgroundAudioService.class));
        }
        if (engine != null) engine.close();
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (downloadReceiver != null) unregisterReceiver(downloadReceiver);
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
        }
        super.onDestroy();
    }
}
