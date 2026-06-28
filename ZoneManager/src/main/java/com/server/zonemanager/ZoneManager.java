package com.server.zonemanager;

import net.milkbowl.vault.economy.Economy;
import org.bukkit.plugin.RegisteredServiceProvider;
import org.bukkit.plugin.java.JavaPlugin;

public class ZoneManager extends JavaPlugin {

    private ZoneStorage storage;
    private Economy economy;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        storage = new ZoneStorage(getDataFolder(), getLogger());
        storage.load();

        economy = setupEconomy();
        if (economy == null) {
            getLogger().warning("Vault/Economy が見つかりません。土地売買機能は無効です。");
        } else {
            getLogger().info("Economy: " + economy.getName() + " に接続しました。");
        }

        getServer().getPluginManager().registerEvents(new ZoneListener(storage), this);
        getCommand("zone").setExecutor(new ZoneCommand(storage, economy));

        // プレイヤー位置を管理パネルに送信（5秒ごと）
        String mapUrl = getConfig().getString("map-server-url", "");
        String apiKey = getConfig().getString("plugin-api-key", "changeme");
        if (mapUrl != null && !mapUrl.isEmpty()) {
            new MapReporter(mapUrl, apiKey).runTaskTimerAsynchronously(this, 20L, 100L);
            getLogger().info("MapReporter 開始 → " + mapUrl);
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
