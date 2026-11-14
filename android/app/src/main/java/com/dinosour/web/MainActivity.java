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
    private static final String KEY_LAST_PAGE = "last_page";
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
    private static final int OPEN_BACKUP = 501, SAVE_BACKUP = 502;
    private static final String[] STORAGE_KEYS = {"dinosour.library.v1", "dinosour.ui.v1"};

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String previousServer = prefs.getString(KEY_SERVER, null);
        serverUrl = Config.APP_ORIGIN;
        setupWindow();
        buildLayout();
        engine = new NativeEngine(this, (id, payload) -> runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed())
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
        webView.setVisibility(View.INVISIBLE);
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
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
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
        title.setText("Can't reach Dinosour");
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
        hint.setText("Dinosour runs on this phone. Connect to Wi-Fi or mobile data, then try again.");
        hint.setTextColor(Color.rgb(170, 170, 170));
        hint.setTextSize(13);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 0, 0, dp(24));
        errorView.addView(hint);

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(v -> loadServer());
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryParams.bottomMargin = dp(8);
        errorView.addView(retry, retryParams);

        Button settings = new Button(this);
        settings.setText("App settings");
        settings.setOnClickListener(v -> showSettings(false));
        errorView.addView(settings);

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
        loadFailed = false;
        hideError();
        progress.setIndeterminate(true);
        progress.setVisibility(View.VISIBLE);
        webView.setVisibility(View.INVISIBLE);
        webView.loadUrl(Config.APP_ORIGIN + "/#home");
    }

    private void showError(String detail) {
        loadFailed = true;
        errorDetail.setText(detail);
        errorView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.INVISIBLE);
        progress.setVisibility(View.GONE);
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
        if (prefs.getBoolean("standalone_migrated", false) || previousServer == null ||
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

    private void testServer(String input) {
        String value = normalizeServer(input);
        if (value == null) {
            toast("Enter an address such as http://192.168.1.10:3210");
            return;
        }
        toast("Checking " + value + "...");
        final String base = value;
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(base + "/api/ping").openConnection();
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("Accept", "application/json");
                int status = connection.getResponseCode();
                runOnUiThread(() -> {
                    if (status == 200) toast("Connected to Dinosour.");
                    else toast("The server answered HTTP " + status + ". Check the address or access link.");
                });
            } catch (Exception error) {
                runOnUiThread(() -> toast("Could not reach " + base + ". Start the server and check the address."));
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
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
            if (path.startsWith("/api/thumb/")) return engine.thumbnail(path.substring("/api/thumb/".length()), "short".equals(uri.getQueryParameter("t")));
            String asset = path.equals("/") ? "index.html" : path.substring(1);
            String mime = asset.endsWith(".html") ? "text/html" :
                    asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" :
                    asset.endsWith(".svg") ? "image/svg+xml" : asset.endsWith(".png") ? "image/png" :
                    asset.endsWith(".json") || asset.endsWith(".webmanifest") ? "application/json" : "text/plain";
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
            progress.setVisibility(View.GONE);
            if (!loadFailed) {
                hideError();
                webView.setVisibility(View.VISIBLE);
                if (url != null && url.startsWith(serverUrl + "/")) prefs.edit().putString(KEY_LAST_PAGE, url).apply();
            }
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
            // 401 is the access-code page and 404 may be an app route. Let the
            // WebView render those response bodies; only hide the app for a real
            // server failure.
            if (request.isForMainFrame() && response.getStatusCode() >= 500) {
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
            webView.setVisibility(View.GONE);
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
            webView.setVisibility(errorView.getVisibility() == View.VISIBLE ? View.INVISIBLE : View.VISIBLE);
            if (customViewCallback != null) {
                customViewCallback.onCustomViewHidden();
                customViewCallback = null;
            }
        }
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void exportBackup(String data) {
            if (data.length() > 2 * 1024 * 1024) return;
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
            if (engine != null) engine.request(id, kind, payload);
        }

        @JavascriptInterface
        public void cancelRequest(String id) {
            if (engine != null) engine.cancel(id);
        }

        @JavascriptInterface
        public String readStorage() {
            JSONObject result = new JSONObject();
            try {
                for (String key : STORAGE_KEYS) if (prefs.contains("web." + key)) result.put(key, prefs.getString("web." + key, ""));
            } catch (Exception ignored) { }
            return result.toString();
        }

        @JavascriptInterface
        public void saveStorage(String key, String value) {
            if (!java.util.Arrays.asList(STORAGE_KEYS).contains(key) || value.length() > 2 * 1024 * 1024) return;
            if (value.isEmpty()) prefs.edit().remove("web." + key).apply();
            else prefs.edit().putString("web." + key, value).apply();
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> showSettings(false));
        }

        @JavascriptInterface
        public void checkForUpdates() {
            runOnUiThread(() -> MainActivity.this.checkForUpdates(Config.UPDATE_ORIGIN));
        }

        @JavascriptInterface
        public String versionName() {
            return BuildConfig.VERSION_NAME;
        }
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
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
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
