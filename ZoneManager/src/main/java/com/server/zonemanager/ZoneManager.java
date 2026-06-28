package com.server.zonemanager;

import org.bukkit.plugin.java.JavaPlugin;

public class ZoneManager extends JavaPlugin {

    private ZoneStorage storage;

    @Override
    public void onEnable() {
        storage = new ZoneStorage(getDataFolder(), getLogger());
        storage.load();

        getServer().getPluginManager().registerEvents(new ZoneListener(storage), this);
        getCommand("zone").setExecutor(new ZoneCommand(storage));

        getLogger().info("ZoneManager 有効化 - " + storage.getAllZones().size() + " ゾーン読み込み済み");
    }

    @Override
    public void onDisable() {
        if (storage != null) storage.save();
        getLogger().info("ZoneManager 無効化");
    }
}
