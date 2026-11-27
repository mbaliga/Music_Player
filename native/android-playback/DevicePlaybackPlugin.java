package com.runout.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Runout "DevicePlayback": the web layer's handle on {@link MediaPlaybackService} (background audio, notification, lock-screen and
 * Bluetooth controls). All methods tolerate being called in any order and never reject for a missing permission.
 *
 *   requestNotificationPermission()          API 33+: asks for POST_NOTIFICATIONS once; resolves {granted}. Denial is tolerated: the
 *                                            service still runs (the OS just hides its notification).
 *   start()                                  start the foreground service. Call only on a play gesture, while the app is visible.
 *   stop()                                   stop the service and remove the notification
 *   setMetadata({title, artist, album, artwork?})  what the notification / lock screen shows; artwork = base64 JPEG / PNG (no data: prefix), optional
 *   setPosition({positionMs, durationMs, seekable})  playhead of the playing track for the seek bar (positionMs < 0 = unknown); the session extrapolates
 *   setState({playing})                      play / pause as the web layer sees it (drives the notification and the wake lock)
 * Events (addListener): play, pause, next, previous (a transport key / notification button / focus change asked for it),
 *                       seek {positionMs} (the seek bar was moved),
 *                       duck {on} (another app wants the audio to go quiet, on=false when it hands it back).
 */
@CapacitorPlugin(
    name = "DevicePlayback",
    permissions = { @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = "notifications") }
)
public class DevicePlaybackPlugin extends Plugin implements MediaPlaybackService.Listener {

    @Override
    public void load() {
        MediaPlaybackService.listener = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (MediaPlaybackService.listener == this) MediaPlaybackService.listener = null;
        // The web layer is gone: nothing can drive the notification buttons, so do not leave a "playing" notification + wake lock behind.
        try { MediaPlaybackService.stop(getContext()); } catch (Exception ignored) { }
        super.handleOnDestroy();
    }

    @Override
    public void onAction(String name, boolean flag) {
        JSObject o = new JSObject();
        o.put("on", flag);
        notifyListeners(name, o);
    }

    @Override
    public void onSeek(long positionMs) {
        JSObject o = new JSObject();
        o.put("positionMs", positionMs);
        notifyListeners("seek", o);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(r);     // denied is not an error: playback works, the notification is simply not shown
    }

    @PluginMethod
    public void start(PluginCall call) {
        try {
            MediaPlaybackService.start(getContext());
            call.resolve();
        } catch (Exception e) {
            call.reject("start failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try { MediaPlaybackService.stop(getContext()); } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void setMetadata(PluginCall call) {
        Bitmap art = null;
        try {
            String b64 = call.getString("artwork", null);
            if (b64 != null && b64.length() > 0 && b64.length() < 2000000) {      // ~1.5 MB of image at most; the web layer sends ~512 px JPEG (tens of KB)
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                art = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            }
        } catch (Exception ignored) { art = null; }        // bad art is no reason to lose the title
        MediaPlaybackService.setMetadata(call.getString("title", ""), call.getString("artist", ""), call.getString("album", ""), art);
        call.resolve();
    }

    @PluginMethod
    public void setPosition(PluginCall call) {
        Long pos = call.getLong("positionMs", -1L), dur = call.getLong("durationMs", 0L);
        MediaPlaybackService.setPosition(pos == null ? -1L : pos, dur == null ? 0L : dur, Boolean.TRUE.equals(call.getBoolean("seekable", false)));
        call.resolve();
    }

    @PluginMethod
    public void setState(PluginCall call) {
        MediaPlaybackService.setPlaying(Boolean.TRUE.equals(call.getBoolean("playing", false)));
        call.resolve();
    }
}
