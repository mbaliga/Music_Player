// SPIKE P1 -- THROWAWAY. NOT COMPILED OR RUN IN THE SANDBOX. UNVERIFIED.
// Capacitor plugin exposed to the spike page as window.Capacitor.Plugins.SpikeBackground.
package com.runout.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

@CapacitorPlugin(
    name = "SpikeBackground",
    permissions = { @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }) }
)
public class SpikeBackgroundPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Android 13+: the foreground-service notification is hidden unless POST_NOTIFICATIONS is granted
        // (the service still runs). Ask once; proceed either way and report what happened.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        doStart(call);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void afterPermission(PluginCall call) { doStart(call); }

    private void doStart(PluginCall call) {
        Intent i = new Intent(getContext(), SpikeForegroundService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i); else getContext().startService(i);
            JSObject r = new JSObject();
            r.put("started", true);
            r.put("sdk", Build.VERSION.SDK_INT);
            r.put("manufacturer", Build.MANUFACTURER);
            r.put("model", Build.MODEL);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("startForegroundService failed: " + e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), SpikeForegroundService.class).setAction("STOP");
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("serviceRunning", SpikeForegroundService.running);
        call.resolve(r);
    }
}
