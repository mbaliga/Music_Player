// SPIKE P1 -- THROWAWAY. NOT COMPILED OR RUN IN THE SANDBOX (no Android SDK). UNVERIFIED until the
// radio-spike-apk workflow builds it and a device runs it.
//
// Minimal media-playback foreground service: ongoing notification (required for a foreground service),
// a framework MediaSession (no androidx dependency) so the lock screen shows transport controls, and a
// PARTIAL_WAKE_LOCK so the CPU keeps running with the screen off. It does NOT play audio itself: audio
// still comes from the WebView's Web Audio. The question this answers is whether holding a foreground
// service + wakelock + MediaSession keeps the WebView's audio alive when the activity is paused.
package com.runout.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class SpikeForegroundService extends Service {
    static final String CHANNEL_ID = "radio_spike";
    static final int NOTIF_ID = 4217;
    static volatile boolean running = false;

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Radio spike", NotificationManager.IMPORTANCE_LOW));
        }
        session = new MediaSession(this, "RadioSpike");
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f).build());
        session.setActive(true);

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        nb.setContentTitle("Runout radio spike").setContentText("Background audio test running")
          .setSmallIcon(android.R.drawable.ic_media_play).setContentIntent(pi).setOngoing(true)
          .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()));
        Notification n = nb.build();

        if (Build.VERSION.SDK_INT >= 29) {
            // Android 14 (API 34) requires the type to be declared in the manifest AND passed here.
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, n);
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "runout:radiospike");
        wakeLock.acquire(2 * 60 * 60 * 1000L); // hard 2 h cap so a forgotten test cannot drain the battery
        running = true;
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (session != null) { session.setActive(false); session.release(); }
        super.onDestroy();
    }
}
