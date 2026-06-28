package com.server.zonemanager;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitRunnable;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collection;

public class MapReporter extends BukkitRunnable {

    private final String serverUrl;
    private final String apiKey;
    private final HttpClient http;

    public MapReporter(String serverUrl, String apiKey) {
        this.serverUrl = serverUrl.replaceAll("/$", "");
        this.apiKey    = apiKey;
        this.http      = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
    }

    @Override
    public void run() {
        Collection<? extends Player> players = Bukkit.getOnlinePlayers();
        StringBuilder sb = new StringBuilder("{\"players\":{");
        boolean first = true;
        for (Player p : players) {
            if (!first) sb.append(',');
            first = false;
            // プレイヤー名をJSON安全にエスケープ
            String safeName = p.getName().replace("\"","\\\"");
            sb.append('"').append(safeName).append("\":{")
              .append("\"x\":").append(Math.round(p.getLocation().getX() * 10) / 10.0).append(',')
              .append("\"y\":").append(Math.round(p.getLocation().getY() * 10) / 10.0).append(',')
              .append("\"z\":").append(Math.round(p.getLocation().getZ() * 10) / 10.0).append(',')
              .append("\"world\":\"").append(p.getWorld().getName()).append('"')
              .append('}');
        }
        sb.append("}}");

        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(serverUrl + "/api/plugin/update"))
                .header("Content-Type", "application/json")
                .header("X-Plugin-Key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(sb.toString(), StandardCharsets.UTF_8))
                .timeout(Duration.ofSeconds(3))
                .build();
            http.sendAsync(request, HttpResponse.BodyHandlers.discarding());
        } catch (Exception ignored) {
            // ネットワーク失敗は無視（コンソールスパム防止）
        }
    }
}
