package com.server.zonemanager;

import net.milkbowl.vault.economy.Economy;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.plugin.RegisteredServiceProvider;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class ZoneManager extends JavaPlugin {

    private ZoneStorage storage;
    private Economy economy;

    // ワンドで選択中の座標（pos1, pos2）
    private final Map<UUID, Location[]> selections = new HashMap<>();

    // ワンドアイテムを識別するカスタムキー
    private NamespacedKey wandKey;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        wandKey = new NamespacedKey(this, "zone_wand");
        storage = new ZoneStorage(getDataFolder(), getLogger());
        storage.load();

        economy = setupEconomy();
        if (economy == null) {
            getLogger().warning("Vault/Economy が見つかりません。土地売買機能は無効です。");
        } else {
            getLogger().info("Economy: " + economy.getName() + " に接続しました。");
        }

        getServer().getPluginManager().registerEvents(new ZoneListener(storage, selections, wandKey), this);
        getCommand("zone").setExecutor(new ZoneCommand(storage, economy, selections, wandKey));

        // プレイヤー位置・地形を管理パネルに送信
        String mapUrl = getConfig().getString("map-server-url", "");
        String apiKey = getConfig().getString("plugin-api-key", "changeme");
        if (mapUrl != null && !mapUrl.isEmpty()) {
            // 位置: 5秒ごと（非同期）
            new MapReporter(mapUrl, apiKey).runTaskTimerAsynchronously(this, 20L, 100L);
            // 地形: 60秒ごと（メインスレッドで取得 → 非同期で送信）
            TerrainScanner scanner = new TerrainScanner(this, mapUrl, apiKey);
            getServer().getScheduler().runTaskTimer(this,
                scanner::scanAndSend, 40L, 1200L);
            getLogger().info("MapReporter / TerrainScanner 開始 → " + mapUrl);
        }

        getLogger().info("ZoneManager 有効化 - " + storage.getAllZones().size() + " ゾーン読み込み済み");
    }

    @Override
    public void onDisable() {
        if (storage != null) storage.save();
        getLogger().info("ZoneManager 無効化");
    }

    private Economy setupEconomy() {
        if (getServer().getPluginManager().getPlugin("Vault") == null) return null;
        RegisteredServiceProvider<Economy> rsp = getServer().getServicesManager().getRegistration(Economy.class);
        return rsp == null ? null : rsp.getProvider();
    }
}
