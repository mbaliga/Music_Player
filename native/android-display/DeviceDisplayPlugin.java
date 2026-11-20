package com.runout.app;

import android.os.Build;
import android.view.Display;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * DeviceDisplay: the three window-level display controls Runout's Device mode needs (docs/DEVICE_MODE.md).
 *
 *   keepAwake({on})                    FLAG_KEEP_SCREEN_ON on the activity window. No permission needed (WAKE_LOCK is NOT required).
 *   setBrightness({fraction|null})     WindowManager.LayoutParams.screenBrightness (0..1); null restores BRIGHTNESS_OVERRIDE_NONE.
 *   setPreferredRefreshRate({hz|null}) LayoutParams.preferredRefreshRate (API 21+) plus, on API 23+, preferredDisplayModeId set to the
 *                                      supported mode with the SAME resolution whose rate is closest to hz. Both are HINTS: the system
 *                                      may ignore them (battery saver, thermal, other windows). null restores "no preference".
 *   getInfo()                          {sdk, keepAwake, currentHz, rates[]} for diagnostics.
 *
 * The window is only touched on the UI thread. Brightness / refresh overrides are dropped on pause and re-applied on resume so a
 * dim AOD setting can never leak into other apps or a later session. Nothing here needs a manifest permission.
 */
@CapacitorPlugin(name = "DeviceDisplay")
public class DeviceDisplayPlugin extends Plugin {
    private Float wantBrightness = null;   // null = no override
    private Float wantHz = null;           // null = no preference
    private boolean wantAwake = false;

    @PluginMethod
    public void keepAwake(final PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        wantAwake = on;
        getBridge().executeOnMainThread(new Runnable() {
            @Override public void run() {
                try {
                    Window w = getActivity().getWindow();
                    if (on) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    call.resolve();
                } catch (Exception e) { call.reject("keepAwake failed: " + e.getMessage()); }
            }
        });
    }

    @PluginMethod
    public void setBrightness(final PluginCall call) {
        Float f = null;
        if (call.getData().has("fraction") && !call.getData().isNull("fraction")) {
            Double d = call.getDouble("fraction");
            if (d != null) f = (float) Math.max(0.01, Math.min(1.0, d));
        }
        wantBrightness = f;
        applyOnUi(call);
    }

    @PluginMethod
    public void setPreferredRefreshRate(final PluginCall call) {
        Float hz = null;
        if (call.getData().has("hz") && !call.getData().isNull("hz")) {
            Double d = call.getDouble("hz");
            if (d != null && d > 0) hz = (float) (double) d;
        }
        wantHz = hz;
        applyOnUi(call);
    }

    @PluginMethod
    public void getInfo(final PluginCall call) {
        getBridge().executeOnMainThread(new Runnable() {
            @Override public void run() {
                try {
                    JSObject o = new JSObject();
                    o.put("sdk", Build.VERSION.SDK_INT);
                    o.put("keepAwake", (getActivity().getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0);
                    Display d = display();
                    JSArray rates = new JSArray();
                    if (d != null) {
                        o.put("currentHz", d.getRefreshRate());
                        if (Build.VERSION.SDK_INT >= 23) { for (Display.Mode m : d.getSupportedModes()) rates.put(m.getRefreshRate()); }
                    }
                    o.put("rates", rates);
                    call.resolve(o);
                } catch (Exception e) { call.reject("getInfo failed: " + e.getMessage()); }
            }
        });
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        try { applyNow(null, null); } catch (Exception ignored) { /* never crash the host app from a lifecycle hook */ }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        try { applyNow(wantBrightness, wantHz); } catch (Exception ignored) { }
    }

    // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────
    private Display display() {
        if (Build.VERSION.SDK_INT >= 30) return getActivity().getDisplay();
        return getActivity().getWindowManager().getDefaultDisplay();
    }

    private void applyOnUi(final PluginCall call) {
        getBridge().executeOnMainThread(new Runnable() {
            @Override public void run() {
                try { applyNow(wantBrightness, wantHz); call.resolve(); }
                catch (Exception e) { call.reject("display override failed: " + e.getMessage()); }
            }
        });
    }

    /** Must run on the UI thread. brightness null -> BRIGHTNESS_OVERRIDE_NONE; hz null -> no preference. */
    private void applyNow(Float brightness, Float hz) {
        Window w = getActivity().getWindow();
        WindowManager.LayoutParams lp = w.getAttributes();
        lp.screenBrightness = brightness == null ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE : brightness;
        lp.preferredRefreshRate = hz == null ? 0f : hz;
        if (Build.VERSION.SDK_INT >= 23) lp.preferredDisplayModeId = hz == null ? 0 : closestModeId(hz);
        w.setAttributes(lp);
    }

    /** The id of the supported mode with the current resolution whose refresh rate is closest to hz, or 0 (no preference). */
    private int closestModeId(float hz) {
        if (Build.VERSION.SDK_INT < 23) return 0;
        Display d = display();
        if (d == null) return 0;
        Display.Mode cur = d.getMode();
        int best = 0;
        float bestDiff = Float.MAX_VALUE;
        for (Display.Mode m : d.getSupportedModes()) {
            if (m.getPhysicalWidth() != cur.getPhysicalWidth() || m.getPhysicalHeight() != cur.getPhysicalHeight()) continue;
            float diff = Math.abs(m.getRefreshRate() - hz);
            if (diff < bestDiff) { bestDiff = diff; best = m.getModeId(); }
        }
        return best;
    }
}
