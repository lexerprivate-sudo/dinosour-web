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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = prefs.getString(KEY_SERVER, null);
        setupWindow();
        buildLayout();
        registerDownloadReceiver();
        if (serverUrl == null) showSettings(true);
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
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
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
        hint.setText("At home, start \"Start Dinosour (LAN).cmd\" and use the address shown in its window. Away from home, start \"Start Dinosour (Public).cmd\" and use the Public link it prints. This address is saved and survives app updates.");
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
        settings.setText("Change server address");
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
        if (serverUrl == null) {
            showSettings(true);
            return;
        }
        loadFailed = false;
        hideError();
        progress.setIndeterminate(true);
        progress.setVisibility(View.VISIBLE);
        webView.setVisibility(View.INVISIBLE);
        String lastPage = prefs.getString(KEY_LAST_PAGE, null);
        String target = lastPage != null && lastPage.startsWith(serverUrl + "/") ? lastPage : serverUrl + "/#home";
        webView.loadUrl(target);
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
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(8), dp(24), 0);

        TextView label = new TextView(this);
        label.setText("Server address");
        label.setTextSize(14);
        box.addView(label);

        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("http://192.168.1.10:3210 or https://…");
        input.setText(serverUrl != null ? serverUrl : Config.DEFAULT_SERVER);
        input.setSelectAllOnFocus(true);
        box.addView(input);

        TextView hint = new TextView(this);
        hint.setText("Use your computer's Wi-Fi address (for example http://10.0.0.5:3210) or the Public link from Start Dinosour (Public).cmd. The address is saved on this device and survives app updates.");
        hint.setTextSize(12);
        hint.setTextColor(Color.rgb(110, 110, 110));
        hint.setPadding(0, dp(8), 0, dp(10));
        box.addView(hint);

        Button test = new Button(this);
        test.setText("Test connection");
        test.setOnClickListener(v -> testServer(input.getText().toString()));
        box.addView(test);

        TextView version = new TextView(this);
        version.setText("Android shell " + BuildConfig.VERSION_NAME);
        version.setTextSize(12);
        version.setTextColor(Color.rgb(150, 150, 150));
        version.setPadding(0, 0, 0, dp(8));
        box.addView(version);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(firstRun ? "Connect to Dinosour" : "App settings")
                .setView(box)
                .setPositiveButton("Save", null)
                .setNegativeButton(firstRun ? "Exit" : "Cancel", null)
                .setNeutralButton("Check for updates", null)
                .create();
        dialog.setCancelable(!firstRun);
        dialog.setOnCancelListener(d -> {
            if (firstRun) finish();
        });
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String value = normalizeServer(input.getText().toString());
            if (value == null) {
                input.setError("Enter an address such as http://192.168.1.10:3210");
                return;
            }
            String previous = serverUrl;
            serverUrl = value;
            SharedPreferences.Editor editor = prefs.edit().putString(KEY_SERVER, value);
            if (!value.equals(previous)) editor.remove(KEY_LAST_PAGE);
            editor.apply();
            dialog.dismiss();
            loadServer();
        });
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
            String value = normalizeServer(input.getText().toString());
            checkForUpdates(value != null ? value : serverUrl);
        });
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(v -> {
            dialog.dismiss();
            if (firstRun) finish();
        });
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
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("http".equals(scheme) || "https".equals(scheme)) return false;
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
                showError("Could not connect to " + serverUrl + ".\n" + description + "\n\nMake sure the Dinosour server is running and the address in Settings matches the LAN address or the Public link shown on the computer.");
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            // 401 is the access-code page and 404 may be an app route. Let the
            // WebView render those response bodies; only hide the app for a real
            // server failure.
            if (request.isForMainFrame() && response.getStatusCode() >= 500) {
                showError("The server answered with HTTP " + response.getStatusCode() + ".\n" + serverUrl);
            }
        }
    }

    private class DinosourChromeClient extends WebChromeClient {
        private View customView;
        private CustomViewCallback customViewCallback;

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
        public void openSettings() {
            runOnUiThread(() -> showSettings(false));
        }

        @JavascriptInterface
        public void checkForUpdates() {
            runOnUiThread(() -> MainActivity.this.checkForUpdates(serverUrl));
        }

        @JavascriptInterface
        public String versionName() {
            return BuildConfig.VERSION_NAME;
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
        if (downloadReceiver != null) unregisterReceiver(downloadReceiver);
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
        }
        super.onDestroy();
    }
}
