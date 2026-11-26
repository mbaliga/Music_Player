package com.runout.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.database.ContentObserver;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Runout "DeviceLibrary": the phone's audio library (MediaStore.Audio) for the web layer.
 *
 * The web app never sees file paths on API 29+ (records carry the volume-relative folder, RELATIVE_PATH); below API 29, where that column
 * does not exist, records also carry the absolute `data` path so the JS can derive the folder. It sees MediaStore row ids and asks for
 *   - signatures()           every audio row as [id, size, dateModified] triples (cheap; drives incremental rescans)
 *   - records({ids})         full metadata rows for those ids
 *   - read({id,offset,len})  a byte range of the file as base64 (the JS DeviceFile is built on this)
 *   - art({id,size})         a small JPEG (base64) of the album art, if any
 *   - generation()           a cheap "has anything changed" token
 * Permissions: READ_MEDIA_AUDIO on API 33+, READ_EXTERNAL_STORAGE (maxSdk 32) below.
 * No MANAGE_EXTERNAL_STORAGE; every byte is read through ContentResolver.
 *
 * Every method returns JSON-safe values only. Heavy work runs on a small executor so the
 * Capacitor plugin thread stays free for permission dialogs and other plugins.
 */
@CapacitorPlugin(
    name = "DeviceLibrary",
    permissions = {
        @Permission(strings = { "android.permission.READ_MEDIA_AUDIO" }, alias = "audio"),
        @Permission(strings = { "android.permission.READ_EXTERNAL_STORAGE" }, alias = "storage")
    }
)
public class DeviceLibraryPlugin extends Plugin {

    private static final int MAX_READ = 4 * 1024 * 1024;
    private static final int MAX_IDS = 800;

    private ExecutorService pool;
    private ContentObserver observer;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable notifyRunnable = new Runnable() {
        @Override public void run() { notifyListeners("libraryChanged", new JSObject()); }
    };

    @Override
    public void load() {
        pool = Executors.newFixedThreadPool(3);
    }

    /** Run on the pool; after handleOnDestroy() the pool is shut down, so reject the call instead of throwing RejectedExecutionException. */
    private void exec(PluginCall call, Runnable r) {
        try {
            if (pool == null) throw new RejectedExecutionException("not loaded");
            pool.execute(r);
        } catch (RejectedExecutionException e) {
            call.reject("library plugin is shutting down");
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopObserving();
        if (pool != null) pool.shutdownNow();
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    private boolean granted() {
        return getPermissionState(alias()) == com.getcapacitor.PermissionState.GRANTED;
    }

    private ContentResolver resolver() {
        return getContext().getContentResolver();
    }

    /** The audio collection across all volumes (internal storage and SD cards). */
    private Uri collection() {
        if (Build.VERSION.SDK_INT >= 29) return MediaStore.Audio.Media.getContentUri("external");
        return MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
    }

    private Uri uriFor(long id) {
        return ContentUris.withAppendedId(collection(), id);
    }

    private static String str(Cursor c, int i) {
        if (i < 0 || c.isNull(i)) return "";
        String s = c.getString(i);
        return s == null ? "" : s;
    }

    private static long lng(Cursor c, int i) {
        if (i < 0 || c.isNull(i)) return 0;
        return c.getLong(i);
    }

    private static int col(Cursor c, String name) {
        return c.getColumnIndex(name);
    }

    private void permissionState(JSObject out) {
        com.getcapacitor.PermissionState s = getPermissionState(alias());
        out.put("state", s == null ? "prompt" : s.toString());
        out.put("sdk", Build.VERSION.SDK_INT);
    }

    // ── permission ──────────────────────────────────────────────────────────

    @PluginMethod
    public void permissionStatus(PluginCall call) {
        JSObject ret = new JSObject();
        permissionState(ret);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (granted()) {
            JSObject ret = new JSObject();
            permissionState(ret);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias(alias(), call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        JSObject ret = new JSObject();
        permissionState(ret);
        call.resolve(ret);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open app settings: " + e.getMessage());
        }
    }

    // ── change detection ────────────────────────────────────────────────────

    /** A cheap token: MediaStore generations on API 30+, else count + newest date_modified. */
    @PluginMethod
    public void generation(final PluginCall call) {
        if (!granted()) { call.reject("permission", "denied"); return; }
        exec(call, new Runnable() {
            @Override
            public void run() {
                try {
                    String token = null;
                    if (Build.VERSION.SDK_INT >= 30) {
                        try {
                            StringBuilder sb = new StringBuilder("g");
                            for (String v : MediaStore.getExternalVolumeNames(getContext())) {
                                sb.append(':').append(v).append('=')
                                  .append(MediaStore.getGeneration(getContext(), v));
                            }
                            token = sb.toString();
                        } catch (Exception ignored) { token = null; }
                    }
                    long count = 0, newest = 0;
                    Cursor c = resolver().query(collection(),
                        new String[] { MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DATE_MODIFIED },
                        MediaStore.Audio.Media.SIZE + " > 0", null, null);
                    if (c != null) {
                        try {
                            while (c.moveToNext()) {
                                count++;
                                long m = c.getLong(1);
                                if (m > newest) newest = m;
                            }
                        } finally { c.close(); }
                    }
                    JSObject ret = new JSObject();
                    ret.put("generation", (token == null ? "c" : token) + "|" + count + "|" + newest);
                    ret.put("count", count);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("generation failed: " + e.getMessage());
                }
            }
        });
    }

    /** Start (or no-op if started) a MediaStore ContentObserver that emits "libraryChanged" (trailing-edge debounced, 1.5 s). */
    @PluginMethod
    public void startObserving(PluginCall call) {
        if (observer == null) {
            observer = new ContentObserver(main) {
                @Override
                public void onChange(boolean selfChange) {
                    // Trailing-edge debounce: every change pushes the notification out, so a burst (a sync, a download folder)
                    // ends in ONE event after it has settled instead of dropping the changes that arrive after the first.
                    main.removeCallbacks(notifyRunnable);
                    main.postDelayed(notifyRunnable, 1500);
                }
            };
            try {
                resolver().registerContentObserver(collection(), true, observer);
            } catch (Exception e) {
                observer = null;
                call.reject("observer failed: " + e.getMessage());
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void stopObserving(PluginCall call) {
        stopObserving();
        call.resolve();
    }

    private void stopObserving() {
        main.removeCallbacks(notifyRunnable);
        if (observer != null) {
            try { resolver().unregisterContentObserver(observer); } catch (Exception ignored) { }
            observer = null;
        }
    }

    // ── enumeration ─────────────────────────────────────────────────────────

    /** Every audio row as a flat [id, size, dateModified, id, size, dateModified, ...] array. */
    @PluginMethod
    public void signatures(final PluginCall call) {
        if (!granted()) { call.reject("permission", "denied"); return; }
        exec(call, new Runnable() {
            @Override
            public void run() {
                Cursor c = null;
                try {
                    String sel = MediaStore.Audio.Media.SIZE + " > 0";
                    if (Build.VERSION.SDK_INT >= 29) sel += " AND " + MediaStore.MediaColumns.IS_PENDING + " = 0";
                    c = resolver().query(collection(), new String[] {
                        MediaStore.Audio.Media._ID, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.DATE_MODIFIED
                    }, sel, null, MediaStore.Audio.Media._ID + " ASC");
                    JSArray flat = new JSArray();
                    if (c != null) {
                        while (c.moveToNext()) {
                            flat.put(c.getLong(0));
                            flat.put(c.getLong(1));
                            flat.put(c.getLong(2));
                        }
                    }
                    JSObject ret = new JSObject();
                    ret.put("sig", flat);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("signatures failed: " + e.getMessage());
                } finally {
                    if (c != null) c.close();
                }
            }
        });
    }

    private String[] projection() {
        List<String> p = new ArrayList<String>();
        p.add(MediaStore.Audio.Media._ID);
        p.add(MediaStore.Audio.Media.DISPLAY_NAME);
        p.add(MediaStore.Audio.Media.TITLE);
        p.add(MediaStore.Audio.Media.ARTIST);
        p.add(MediaStore.Audio.Media.ALBUM);
        p.add(MediaStore.Audio.Media.ALBUM_ID);
        p.add(MediaStore.Audio.Media.TRACK);
        p.add(MediaStore.Audio.Media.YEAR);
        p.add(MediaStore.Audio.Media.DURATION);
        p.add(MediaStore.Audio.Media.SIZE);
        p.add(MediaStore.Audio.Media.MIME_TYPE);
        p.add(MediaStore.Audio.Media.DATE_MODIFIED);
        p.add(MediaStore.Audio.Media.DATA);
        p.add(MediaStore.Audio.Media.IS_MUSIC);
        p.add(MediaStore.Audio.Media.IS_RINGTONE);
        p.add(MediaStore.Audio.Media.IS_ALARM);
        p.add(MediaStore.Audio.Media.IS_NOTIFICATION);
        p.add(MediaStore.Audio.Media.IS_PODCAST);
        if (Build.VERSION.SDK_INT >= 29) {
            p.add(MediaStore.MediaColumns.RELATIVE_PATH);
            p.add(MediaStore.MediaColumns.VOLUME_NAME);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            p.add(MediaStore.Audio.Media.ALBUM_ARTIST);
            p.add(MediaStore.Audio.Media.GENRE);
            p.add(MediaStore.Audio.Media.DISC_NUMBER);
            p.add(MediaStore.Audio.Media.CD_TRACK_NUMBER);
        }
        return p.toArray(new String[0]);
    }

    /** Full metadata rows for up to MAX_IDS ids. */
    @PluginMethod
    public void records(final PluginCall call) {
        if (!granted()) { call.reject("permission", "denied"); return; }
        final JSArray idArr = call.getArray("ids");
        if (idArr == null) { call.reject("ids required"); return; }
        exec(call, new Runnable() {
            @Override
            public void run() {
                Cursor c = null;
                try {
                    int n = Math.min(idArr.length(), MAX_IDS);
                    if (n == 0) {
                        JSObject empty = new JSObject();
                        empty.put("items", new JSArray());
                        call.resolve(empty);
                        return;
                    }
                    StringBuilder sel = new StringBuilder(MediaStore.Audio.Media._ID + " IN (");
                    for (int i = 0; i < n; i++) {
                        if (i > 0) sel.append(',');
                        sel.append(idArr.getLong(i));
                    }
                    sel.append(')');
                    c = resolver().query(collection(), projection(), sel.toString(), null, MediaStore.Audio.Media._ID + " ASC");
                    JSArray items = new JSArray();
                    if (c != null) {
                        int iId = col(c, MediaStore.Audio.Media._ID);
                        int iName = col(c, MediaStore.Audio.Media.DISPLAY_NAME);
                        int iTitle = col(c, MediaStore.Audio.Media.TITLE);
                        int iArtist = col(c, MediaStore.Audio.Media.ARTIST);
                        int iAlbum = col(c, MediaStore.Audio.Media.ALBUM);
                        int iAlbumId = col(c, MediaStore.Audio.Media.ALBUM_ID);
                        int iTrack = col(c, MediaStore.Audio.Media.TRACK);
                        int iYear = col(c, MediaStore.Audio.Media.YEAR);
                        int iDur = col(c, MediaStore.Audio.Media.DURATION);
                        int iSize = col(c, MediaStore.Audio.Media.SIZE);
                        int iMime = col(c, MediaStore.Audio.Media.MIME_TYPE);
                        int iMod = col(c, MediaStore.Audio.Media.DATE_MODIFIED);
                        int iData = col(c, MediaStore.Audio.Media.DATA);
                        int iMusic = col(c, MediaStore.Audio.Media.IS_MUSIC);
                        int iRing = col(c, MediaStore.Audio.Media.IS_RINGTONE);
                        int iAlarm = col(c, MediaStore.Audio.Media.IS_ALARM);
                        int iNotif = col(c, MediaStore.Audio.Media.IS_NOTIFICATION);
                        int iPod = col(c, MediaStore.Audio.Media.IS_PODCAST);
                        int iRel = Build.VERSION.SDK_INT >= 29 ? col(c, MediaStore.MediaColumns.RELATIVE_PATH) : -1;
                        int iVol = Build.VERSION.SDK_INT >= 29 ? col(c, MediaStore.MediaColumns.VOLUME_NAME) : -1;
                        int iAA = Build.VERSION.SDK_INT >= 30 ? col(c, MediaStore.Audio.Media.ALBUM_ARTIST) : -1;
                        int iGenre = Build.VERSION.SDK_INT >= 30 ? col(c, MediaStore.Audio.Media.GENRE) : -1;
                        int iDisc = Build.VERSION.SDK_INT >= 30 ? col(c, MediaStore.Audio.Media.DISC_NUMBER) : -1;
                        int iCdTrack = Build.VERSION.SDK_INT >= 30 ? col(c, MediaStore.Audio.Media.CD_TRACK_NUMBER) : -1;
                        while (c.moveToNext()) {
                            JSObject o = new JSObject();
                            o.put("id", lng(c, iId));
                            o.put("name", str(c, iName));
                            o.put("title", str(c, iTitle));
                            o.put("artist", str(c, iArtist));
                            o.put("album", str(c, iAlbum));
                            o.put("albumId", lng(c, iAlbumId));
                            o.put("albumArtist", str(c, iAA));
                            o.put("genre", str(c, iGenre));
                            o.put("track", lng(c, iTrack));
                            o.put("cdTrack", str(c, iCdTrack));
                            o.put("disc", str(c, iDisc));
                            o.put("year", lng(c, iYear));
                            o.put("durationMs", lng(c, iDur));
                            o.put("size", lng(c, iSize));
                            o.put("mime", str(c, iMime));
                            o.put("modified", lng(c, iMod));
                            // API 29+: the folder comes from RELATIVE_PATH below; the absolute path is only a < 29 fallback (records.js relativeFromData).
                            if (Build.VERSION.SDK_INT < 29) o.put("data", str(c, iData));
                            o.put("relativePath", str(c, iRel));
                            o.put("volume", str(c, iVol));
                            o.put("isMusic", lng(c, iMusic) != 0);
                            o.put("isRingtone", lng(c, iRing) != 0);
                            o.put("isAlarm", lng(c, iAlarm) != 0);
                            o.put("isNotification", lng(c, iNotif) != 0);
                            o.put("isPodcast", lng(c, iPod) != 0);
                            items.put(o);
                        }
                    }
                    JSObject ret = new JSObject();
                    ret.put("items", items);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("records failed: " + e.getMessage());
                } finally {
                    if (c != null) c.close();
                }
            }
        });
    }

    // ── bytes ───────────────────────────────────────────────────────────────

    /** Read up to `length` bytes at `offset`; returns base64 (no wrap), the byte count, and eof. */
    @PluginMethod
    public void read(final PluginCall call) {
        if (!granted()) { call.reject("permission", "denied"); return; }
        final Long id = call.getLong("id");
        final Long offset = call.getLong("offset", 0L);
        final Integer length = call.getInt("length", 1024 * 1024);
        if (id == null || offset == null || length == null || offset < 0 || length < 0) {
            call.reject("id, offset, length required");
            return;
        }
        exec(call, new Runnable() {
            @Override
            public void run() {
                ParcelFileDescriptor pfd = null;
                FileInputStream in = null;
                try {
                    pfd = resolver().openFileDescriptor(uriFor(id), "r");
                    if (pfd == null) { call.reject("not found", "ENOENT"); return; }
                    in = new FileInputStream(pfd.getFileDescriptor());
                    FileChannel ch = in.getChannel();
                    long size = ch.size();
                    int want = (int) Math.min((long) Math.min(length, MAX_READ), Math.max(0L, size - offset));
                    ByteBuffer buf = ByteBuffer.allocate(want);
                    long pos = offset;
                    while (buf.hasRemaining()) {
                        int n = ch.read(buf, pos);
                        if (n <= 0) break;
                        pos += n;
                    }
                    JSObject ret = new JSObject();
                    ret.put("data", Base64.encodeToString(buf.array(), 0, buf.position(), Base64.NO_WRAP));
                    ret.put("bytes", buf.position());
                    ret.put("size", size);
                    ret.put("eof", offset + buf.position() >= size);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("read failed: " + e.getMessage(), "EIO");
                } finally {
                    try { if (in != null) in.close(); } catch (Exception ignored) { }
                    try { if (pfd != null) pfd.close(); } catch (Exception ignored) { }
                }
            }
        });
    }

    // ── album art ───────────────────────────────────────────────────────────

    /** A JPEG (base64) no larger than `size` px, or {data:""} when the track has no art. */
    @PluginMethod
    public void art(final PluginCall call) {
        if (!granted()) { call.reject("permission", "denied"); return; }
        final Long id = call.getLong("id");
        final Integer size = call.getInt("size", 256);
        if (id == null || size == null) { call.reject("id required"); return; }
        exec(call, new Runnable() {
            @Override
            public void run() {
                Bitmap bmp = null;
                try {
                    int px = Math.max(48, Math.min(size, 1024));
                    if (Build.VERSION.SDK_INT >= 29) {
                        try { bmp = resolver().loadThumbnail(uriFor(id), new Size(px, px), null); }
                        catch (Exception | OutOfMemoryError ignored) { bmp = null; }
                    }
                    if (bmp == null) bmp = embeddedArt(id, px);
                    JSObject ret = new JSObject();
                    if (bmp == null) {
                        ret.put("data", "");
                    } else {
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out);
                        ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                        ret.put("mime", "image/jpeg");
                    }
                    call.resolve(ret);
                } catch (Exception | OutOfMemoryError e) {
                    call.reject("art failed: " + e.getMessage());
                } finally {
                    if (bmp != null) bmp.recycle();
                }
            }
        });
    }

    /** Fallback (API < 29, or a thumbnail failure): the picture embedded in the file's tags, downscaled. */
    private Bitmap embeddedArt(long id, int px) {
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        ParcelFileDescriptor pfd = null;
        try {
            pfd = resolver().openFileDescriptor(uriFor(id), "r");
            if (pfd == null) return null;
            mmr.setDataSource(pfd.getFileDescriptor());
            byte[] pic = mmr.getEmbeddedPicture();
            if (pic == null || pic.length == 0) return null;
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(pic, 0, pic.length, bounds);
            int sample = 1;
            while (bounds.outWidth / (sample * 2) >= px && bounds.outHeight / (sample * 2) >= px) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            return BitmapFactory.decodeByteArray(pic, 0, pic.length, opts);
        } catch (Exception | OutOfMemoryError e) {
            return null;
        } finally {
            try { mmr.release(); } catch (Exception ignored) { }
            try { if (pfd != null) pfd.close(); } catch (Exception ignored) { }
        }
    }
}
