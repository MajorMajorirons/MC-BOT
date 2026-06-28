package com.server.personalpvp;

import org.bukkit.plugin.java.JavaPlugin;

import java.io.*;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

public class PersonalPVP extends JavaPlugin {

    private final Set<UUID> pvpDisabled = new HashSet<>();
    private File dataFile;

    @Override
    public void onEnable() {
        dataFile = new File(getDataFolder(), "pvp_off.txt");
        loadData();
        getServer().getPluginManager().registerEvents(new PVPListener(this), this);
        getCommand("pvp").setExecutor(new PVPCommand(this));
        getLogger().info("PersonalPVP 有効化 - 個人PVPトグル機能が使用可能です");
    }

    @Override
    public void onDisable() {
        saveData();
        getLogger().info("PersonalPVP 無効化");
    }

    public boolean isPvpEnabled(UUID uuid) {
        return !pvpDisabled.contains(uuid);
    }

    public void setPvpEnabled(UUID uuid, boolean enabled) {
        if (enabled) {
            pvpDisabled.remove(uuid);
        } else {
            pvpDisabled.add(uuid);
        }
        saveData();
    }

    private void loadData() {
        if (!dataFile.exists()) return;
        try (BufferedReader reader = new BufferedReader(new FileReader(dataFile))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (!line.isEmpty()) {
                    try {
                        pvpDisabled.add(UUID.fromString(line));
                    } catch (IllegalArgumentException ignored) {}
                }
            }
        } catch (IOException e) {
            getLogger().warning("PVPデータの読み込みに失敗: " + e.getMessage());
        }
    }

    private void saveData() {
        try {
            dataFile.getParentFile().mkdirs();
            try (BufferedWriter writer = new BufferedWriter(new FileWriter(dataFile))) {
                for (UUID uuid : pvpDisabled) {
                    writer.write(uuid.toString());
                    writer.newLine();
                }
            }
        } catch (IOException e) {
            getLogger().warning("PVPデータの保存に失敗: " + e.getMessage());
        }
    }
}
