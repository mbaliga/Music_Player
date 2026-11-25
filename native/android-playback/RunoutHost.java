package com.runout.app;

import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import android.view.ViewTreeObserver;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import java.util.Collections;

/**
 * Activity-level glue Runout needs that no single plugin owns. Installed from MainActivity.onCreate (after super.onCreate) by
 * scripts/apply-android-playback.mjs:
 *
 *   1. Hardware Back FALLBACK. The primary route is the web layer's @capacitor/app "backButton" listener. If the App plugin is not in
 *      this build, Back is routed to window.__runoutBack() (src/backbutton.js): it returns true when it closed a layer; otherwise the
 *      task is moved to the background. (The activity is never finished: a music player keeps playing.)
 *   2. System gesture exclusion for the left-edge drawer strip, so the Android gesture-navigation Back swipe does not steal it.
 *      API 29+, one rect on the left edge, at most 200 dp tall (the OS cap per edge), re-applied on every layout.
 */
final class RunoutHost {
    private static final int EDGE_DP = 32;      // the in-app strip is 24 px wide; a little extra for a thumb
    private static final int MAX_TALL_DP = 200; // Android ignores more than 200 dp of exclusion per edge
    private static final int TOP_MIN_DP = 112;  // below the page header (hamburger, title, lock key)

    private RunoutHost() { }

    static void install(final BridgeActivity activity) {
        try { installBackFallback(activity); } catch (Exception ignored) { }
        try { installGestureExclusion(activity); } catch (Exception ignored) { }
    }

    private static void installBackFallback(final BridgeActivity activity) {
        try {
            if (activity.getBridge() != null && activity.getBridge().getPlugin("App") != null) return;   // @capacitor/app owns Back
        } catch (Exception ignored) { /* no bridge yet: install the fallback */ }
        activity.getOnBackPressedDispatcher().addCallback(activity, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = null;
                try { wv = activity.getBridge().getWebView(); } catch (Exception ignored) { }
                if (wv == null) { activity.moveTaskToBack(true); return; }
                wv.evaluateJavascript(
                    "(function(){try{return !!(window.__runoutBack&&window.__runoutBack());}catch(e){return false;}})()",
                    new ValueCallback<String>() {
                        @Override public void onReceiveValue(String handled) {
                            if (!"true".equals(handled)) activity.moveTaskToBack(true);
                        }
                    });
            }
        });
    }

    private static void installGestureExclusion(final BridgeActivity activity) {
        if (Build.VERSION.SDK_INT < 29) return;
        final View decor = activity.getWindow().getDecorView();
        final float density = activity.getResources().getDisplayMetrics().density;
        final Rect[] last = new Rect[1];
        final ViewTreeObserver.OnGlobalLayoutListener apply = new ViewTreeObserver.OnGlobalLayoutListener() {
            @Override public void onGlobalLayout() {
                int h = decor.getHeight();
                if (h <= 0) return;
                int tall = Math.min(Math.round(MAX_TALL_DP * density), h);
                int top = Math.max(Math.round(TOP_MIN_DP * density), (h - tall) / 2);
                if (top + tall > h) top = Math.max(0, h - tall);
                Rect r = new Rect(0, top, Math.round(EDGE_DP * density), top + tall);
                if (r.equals(last[0])) return;
                last[0] = r;
                decor.setSystemGestureExclusionRects(Collections.singletonList(r));
            }
        };
        decor.getViewTreeObserver().addOnGlobalLayoutListener(apply);
        decor.post(new Runnable() { @Override public void run() { apply.onGlobalLayout(); } });
    }
}
