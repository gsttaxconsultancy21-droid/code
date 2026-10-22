package com.inkland.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

/**
 * Hosts the bundled game (assets/index.html) in a fullscreen WebView.
 * Everything ships inside the APK; the network is only used to join a
 * same-Wi-Fi multiplayer server the player types in.
 */
public class MainActivity extends Activity {
    private static final String HOME = "file:///android_asset/index.html";
    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF2F3150);
        webView.setWebViewClient(new LocalOnlyClient());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setAllowContentAccess(false);
        webView.addJavascriptInterface(new NativeBridge(this), "InklandNative");
        setContentView(webView);
        hideSystemBars();

        if (Build.VERSION.SDK_INT >= 33) BackHandler33.register(this);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(HOME);
        }
    }

    private void hideSystemBars() {
        webView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    /** Asks the game to handle Back (pause / leave a screen); exits from the main menu. */
    void handleBack() {
        webView.evaluateJavascript("window.inklandBack ? window.inklandBack() : false", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if (!"true".equals(handled)) finish();
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Android 12L and older. Android 13+ uses the OnBackInvokedCallback below. */
    @Override
    public void onBackPressed() {
        handleBack();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
        webView.pauseTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.resumeTimers();
        webView.onResume();
        hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }

    /** Keeps the WebView on the bundled game; it never browses elsewhere. */
    static class LocalOnlyClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !request.getUrl().toString().startsWith("file:///android_asset/");
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !url.startsWith("file:///android_asset/");
        }
    }

    /** Predictive-back-compatible handling for Android 13+ (API 33). */
    static class BackHandler33 {
        static void register(final MainActivity activity) {
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    new OnBackInvokedCallback() {
                        @Override
                        public void onBackInvoked() {
                            activity.handleBack();
                        }
                    });
        }
    }

    /** Exposed to the game as window.InklandNative (WebView ignores navigator.vibrate). */
    static class NativeBridge {
        private final Vibrator vibrator;

        NativeBridge(Context context) {
            vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
        }

        /** Pattern as comma-separated milliseconds: "30" or "0,40,50,70" (off, on, off, on...). */
        @JavascriptInterface
        public void vibrate(String pattern) {
            if (vibrator == null || !vibrator.hasVibrator() || pattern == null || pattern.length() > 64) return;
            try {
                String[] parts = pattern.split(",");
                if (parts.length == 1) {
                    long ms = Math.min(1000L, Math.max(1L, Long.parseLong(parts[0].trim())));
                    if (Build.VERSION.SDK_INT >= 26) {
                        vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        vibrator.vibrate(ms);
                    }
                    return;
                }
                long[] timings = new long[Math.min(parts.length, 8)];
                for (int i = 0; i < timings.length; i++) {
                    timings[i] = Math.min(1000L, Math.max(0L, Long.parseLong(parts[i].trim())));
                }
                if (Build.VERSION.SDK_INT >= 26) {
                    vibrator.vibrate(VibrationEffect.createWaveform(timings, -1));
                } else {
                    vibrator.vibrate(timings, -1);
                }
            } catch (NumberFormatException ignored) {
                // Bad pattern from the page: ignore.
            }
        }
    }
}
