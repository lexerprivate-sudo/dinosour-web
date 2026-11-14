package com.dinosour.web;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

// Keeps the process alive while the interface plays media, so sound continues
// when the screen is off or another app is in the foreground. The interface
// starts this service when playback begins and stops it when playback ends.
public class BackgroundAudioService extends Service {
    public interface Controls { void toggle(); }

    public static volatile boolean playing;
    public static volatile String title = "";
    public static volatile Controls toggleControls;
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 41;
    private static final String ACTION_TOGGLE = "com.dinosour.web.BACKGROUND_AUDIO_TOGGLE";
    static final String ACTION_REFRESH = "com.dinosour.web.BACKGROUND_AUDIO_REFRESH";

    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_TOGGLE.equals(intent.getAction())) {
            Controls controls = toggleControls;
            if (controls != null) controls.toggle();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_REFRESH.equals(intent.getAction())) {
            refresh();
            return START_NOT_STICKY;
        }
        startInForeground();
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (wakeLock == null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dinosour:background-audio");
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
        return START_NOT_STICKY;
    }

    // Called by MainActivity after each interface state change so the
    // notification reflects what is actually playing.
    void refresh() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification());
    }

    private void startInForeground() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel channel = new NotificationChannel(CHANNEL, "Background playback",
                        NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("Shows while Dinosour plays audio in the background.");
                manager.createNotificationChannel(channel);
            }
        }
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        PendingIntent content = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent toggle = PendingIntent.getService(this, 1,
                new Intent(this, BackgroundAudioService.class).setAction(ACTION_TOGGLE),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title.isEmpty() ? "Dinosour" : title)
                .setContentText(playing ? "Playing in background" : "Paused")
                .setContentIntent(content)
                .setOnlyAlertOnce(true)
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= 23) {
            builder.addAction(new Notification.Action.Builder(null,
                    playing ? "Pause" : "Play", toggle).build());
        } else {
            builder.addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? "Pause" : "Play", toggle);
        }
        return builder.build();
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        toggleControls = null;
        super.onDestroy();
    }
}
