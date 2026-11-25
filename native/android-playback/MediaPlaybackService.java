package com.runout.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Runout background playback (docs/DEVICE_LIBRARY.md, "Background playback").
 *
 * The audio itself is the WebView's (an AudioWorklet); this foreground service is what keeps the PROCESS alive and un-throttled while the
 * screen is off or the app is in the background, and gives the phone its standard media surface:
 *   - a MediaSession (lock-screen / Bluetooth / headset buttons, title + artist + album)
 *   - a MediaStyle notification with previous / play-pause / next
 *   - audio focus (pause on loss and on transient loss, duck, resume on gain) and ACTION_AUDIO_BECOMING_NOISY (headphones unplugged)
 *   - a partial wake lock while playing, so the JS transport driver keeps its timer
 * Every user action is forwarded to the web layer through {@link Listener} (the DevicePlayback plugin); the web app owns what "play",
 * "pause", "next" and "previous" mean for the album, mixtape or radio that is playing, and reports its state back with setState().
 *
 * The service is only ever STARTED by the plugin on a play gesture while the app is in the foreground (a foreground service cannot be
 * started from the background on API 31+). Only platform classes are used (no AndroidX media library to pull in).
 */
public class MediaPlaybackService extends Service {

    /** Implemented by the plugin: name is play | pause | next | previous | duck (flag = ducking on) | stopped. Called on the main thread. */
    public interface Listener { void onAction(String name, boolean flag); }

    static final String ACTION_START = "com.runout.app.playback.START";
    static final String ACTION_PLAY = "com.runout.app.playback.PLAY";
    static final String ACTION_PAUSE = "com.runout.app.playback.PAUSE";
    static final String ACTION_NEXT = "com.runout.app.playback.NEXT";
    static final String ACTION_PREV = "com.runout.app.playback.PREV";
    static final String ACTION_STOP = "com.runout.app.playback.STOP";

    private static final String CHANNEL_ID = "runout_playback";
    private static final int NOTIF_ID = 4711;
    private static final long WAKE_LOCK_MAX_MS = 6L * 60L * 60L * 1000L;

    static volatile Listener listener;
    private static volatile MediaPlaybackService instance;
    // The wanted state lives in statics so a metadata / state call that races the service start is not lost.
    private static volatile String title = "Runout";
    private static volatile String artist = "";
    private static volatile String album = "";
    private static volatile boolean playing = false;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaSession session;
    private NotificationManager nm;
    private AudioManager audio;
    private PowerManager.WakeLock wakeLock;
    private AudioFocusRequest focusRequest;
    private boolean foreground = false;
    private boolean haveFocus = false;
    private boolean resumeOnFocusGain = false;
    private boolean noisyRegistered = false;

    // ── entry points used by the plugin (any thread) ────────────────────────────────────────────────────────────────

    /** Start (or re-promote) the service. Call only from the foreground app, on a play gesture. */
    static void start(Context ctx) {
        playing = true;
        Intent i = new Intent(ctx, MediaPlaybackService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    static void stop(Context ctx) {
        playing = false;
        ctx.stopService(new Intent(ctx, MediaPlaybackService.class));
    }

    static void setMetadata(String t, String a, String al) {
        title = t == null || t.length() == 0 ? "Runout" : t;
        artist = a == null ? "" : a;
        album = al == null ? "" : al;
        poke();
    }

    static void setPlaying(boolean p) {
        playing = p;
        poke();
    }

    private static void poke() {
        final MediaPlaybackService s = instance;
        if (s != null) s.main.post(new Runnable() { @Override public void run() { s.refresh(); } });
    }

    // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Now playing controls");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSession(this, "Runout");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { emit("play", false); }
            @Override public void onPause() { emit("pause", false); }
            @Override public void onSkipToNext() { emit("next", false); }
            @Override public void onSkipToPrevious() { emit("previous", false); }
            @Override public void onStop() { emit("pause", false); }
        }, main);
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (a == null || ACTION_START.equals(a)) {
            // startForegroundService() obliges a startForeground() within seconds, whatever state the web layer reports next.
            promote(buildNotification(playing));
            refresh();
        } else if (ACTION_PLAY.equals(a)) { emit("play", false); }
        else if (ACTION_PAUSE.equals(a)) { emit("pause", false); }
        else if (ACTION_NEXT.equals(a)) { emit("next", false); }
        else if (ACTION_PREV.equals(a)) { emit("previous", false); }
        else if (ACTION_STOP.equals(a)) { playing = false; stopSelf(); }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiped out of recents: the web layer is going away with the task, so the service has nothing left to keep alive.
        playing = false;
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        emit("stopped", false);
        unregisterNoisy();
        releaseWakeLock();
        abandonFocus();
        try { stopForeground(true); } catch (Exception ignored) { }
        foreground = false;
        if (session != null) { try { session.setActive(false); session.release(); } catch (Exception ignored) { } session = null; }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ── state -> session, notification, focus, wake lock ────────────────────────────────────────────────────────────

    private void emit(String name, boolean flag) {
        Listener l = listener;
        if (l != null) { try { l.onAction(name, flag); } catch (Exception ignored) { } }
    }

    private void refresh() {
        if (session == null) return;
        final boolean p = playing;

        MediaMetadata.Builder md = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album);
        session.setMetadata(md.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            .setState(p ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, p ? 1f : 0f)
            .build());

        Notification n = buildNotification(p);
        if (p) {
            promote(n);
            acquireWakeLock();
            requestFocus();
            registerNoisy();
        } else {
            releaseWakeLock();
            unregisterNoisy();
            if (!resumeOnFocusGain) abandonFocus();
            if (foreground) {
                // Paused: stay as an ordinary, swipe-away media notification (the session keeps handling Bluetooth "play").
                try { stopForeground(false); } catch (Exception ignored) { }
                foreground = false;
            }
            if (nm != null) nm.notify(NOTIF_ID, n);
        }
    }

    private void promote(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIF_ID, n);
            foreground = true;
        } catch (Exception e) {
            // e.g. ForegroundServiceStartNotAllowedException when re-promoting from the background: show the notification and carry on.
            foreground = false;
            if (nm != null) { try { nm.notify(NOTIF_ID, n); } catch (Exception ignored) { } }
        }
    }

    private Notification buildNotification(boolean p) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        int icon = getResources().getIdentifier("ic_stat_runout", "drawable", getPackageName());
        if (icon == 0) icon = android.R.drawable.ic_media_play;
        b.setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(artist.length() > 0 ? artist : album)
            .setSubText(artist.length() > 0 ? album : null)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(p)
            .setContentIntent(launchIntent())
            .setDeleteIntent(serviceIntent(ACTION_STOP));
        b.addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV));
        if (p) b.addAction(action(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE));
        else b.addAction(action(android.R.drawable.ic_media_play, "Play", ACTION_PLAY));
        b.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT));
        Notification.MediaStyle style = new Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2);
        if (session != null) style.setMediaSession(session.getSessionToken());
        b.setStyle(style);
        return b.build();
    }

    @SuppressWarnings("deprecation")
    private Notification.Action action(int icon, String label, String act) {
        return new Notification.Action.Builder(icon, label, serviceIntent(act)).build();
    }

    private PendingIntent serviceIntent(String act) {
        Intent i = new Intent(this, MediaPlaybackService.class).setAction(act);
        int f = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getService(this, act.hashCode(), i, f);
    }

    private PendingIntent launchIntent() {
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i == null) i = new Intent();
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int f = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, 0, i, f);
    }

    // ── wake lock ────────────────────────────────────────────────────────────────────────────────────────────────────

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "runout:playback");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire(WAKE_LOCK_MAX_MS);
        } catch (Exception ignored) { }
    }

    private void releaseWakeLock() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) { }
    }

    // ── audio focus ──────────────────────────────────────────────────────────────────────────────────────────────────

    private final AudioManager.OnAudioFocusChangeListener focusListener = new AudioManager.OnAudioFocusChangeListener() {
        @Override public void onAudioFocusChange(int change) {
            switch (change) {
                case AudioManager.AUDIOFOCUS_GAIN:
                    haveFocus = true;
                    emit("duck", false);
                    if (resumeOnFocusGain) { resumeOnFocusGain = false; if (!playing) emit("play", false); }
                    break;
                case AudioManager.AUDIOFOCUS_LOSS:            // another app took over for good: pause and let go
                    haveFocus = false;
                    resumeOnFocusGain = false;
                    emit("pause", false);
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:  // a call, a navigation prompt: pause, resume when it hands the focus back
                    if (playing) { resumeOnFocusGain = true; emit("pause", false); }
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                    emit("duck", true);
                    break;
                default: break;
            }
        }
    };

    private void requestFocus() {
        if (haveFocus || audio == null) return;
        try {
            int r;
            if (Build.VERSION.SDK_INT >= 26) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(focusListener, main)
                    .build();
                r = audio.requestAudioFocus(focusRequest);
            } else {
                r = audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
            // Denied / delayed: keep playing (the user asked for it); the listener will tell us if the focus is taken later.
            haveFocus = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } catch (Exception ignored) { }
    }

    private void abandonFocus() {
        if (audio == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) { if (focusRequest != null) audio.abandonAudioFocusRequest(focusRequest); }
            else audio.abandonAudioFocus(focusListener);
        } catch (Exception ignored) { }
        focusRequest = null;
        haveFocus = false;
    }

    // ── headphones unplugged / Bluetooth dropped ────────────────────────────────────────────────────────────────────

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) { resumeOnFocusGain = false; emit("pause", false); }
        }
    };

    private void registerNoisy() {
        if (noisyRegistered) return;
        try {
            IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisyReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(noisyReceiver, f);
            noisyRegistered = true;
        } catch (Exception ignored) { }
    }

    private void unregisterNoisy() {
        if (!noisyRegistered) return;
        try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) { }
        noisyRegistered = false;
    }
}
