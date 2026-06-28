package com.server.zonemanager;

import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.util.*;
import java.util.logging.Logger;

public class ZoneStorage {

    private final File file;
    private final Logger log;
    private final Map<String, Zone> zones = new LinkedHashMap<>();

    public ZoneStorage(File dataFolder, Logger log) {
        this.file = new File(dataFolder, "zones.yml");
        this.log  = log;
    }

    public void load() {
        zones.clear();
        if (!file.exists()) return;
        YamlConfiguration cfg = YamlConfiguration.loadConfiguration(file);
        ConfigurationSection sec = cfg.getConfigurationSection("zones");
        if (sec == null) return;

        for (String name : sec.getKeys(false)) {
            ConfigurationSection z = sec.getConfigurationSection(name);
            if (z == null) continue;
            try {
                Zone zone = new Zone(
                    name,
                    z.getString("world", "world"),
                    z.getInt("x1"), z.getInt("y1"), z.getInt("z1"),
                    z.getInt("x2"), z.getInt("y2"), z.getInt("z2"),
                    z.contains("owner_uuid") ? z.getString("owner_uuid") : null,
                    z.getString("owner_name", "ADMIN"),
                    z.getBoolean("explosion_protected", true),
                    z.getLong("created_at", System.currentTimeMillis())
                );
                zone.setSellPrice(z.getDouble("sell_price", 0));
                zones.put(name.toLowerCase(), zone);
            } catch (Exception e) {
                log.warning("ゾーン読み込み失敗: " + name + " - " + e.getMessage());
            }
        }
        log.info(zones.size() + " ゾーンを読み込みました。");
    }

    public void save() {
        YamlConfiguration cfg = new YamlConfiguration();
        for (Zone z : zones.values()) {
            String path = "zones." + z.getName();
            cfg.set(path + ".world",                z.getWorld());
            cfg.set(path + ".x1",                   z.getX1());
            cfg.set(path + ".y1",                   z.getY1());
            cfg.set(path + ".z1",                   z.getZ1());
            cfg.set(path + ".x2",                   z.getX2());
            cfg.set(path + ".y2",                   z.getY2());
            cfg.set(path + ".z2",                   z.getZ2());
            cfg.set(path + ".owner_uuid",            z.getOwnerUuid());
            cfg.set(path + ".owner_name",            z.getOwnerName());
            cfg.set(path + ".explosion_protected",   z.isExplosionProtected());
            cfg.set(path + ".sell_price",            z.getSellPrice());
            cfg.set(path + ".created_at",            z.getCreatedAt());
        }
        try {
            file.getParentFile().mkdirs();
            cfg.save(file);
        } catch (IOException e) {
            log.severe("ゾーン保存失敗: " + e.getMessage());
        }
    }

    public void addZone(Zone zone) {
        zones.put(zone.getName().toLowerCase(), zone);
        save();
    }

    public boolean removeZone(String name) {
        boolean removed = zones.remove(name.toLowerCase()) != null;
        if (removed) save();
        return removed;
    }

    public Zone getZone(String name) {
        return zones.get(name.toLowerCase());
    }

    public Collection<Zone> getAllZones() {
        return Collections.unmodifiableCollection(zones.values());
    }

    /** 指定座標を含むゾーン一覧 */
    public List<Zone> getZonesAt(String world, int x, int y, int z) {
        List<Zone> result = new ArrayList<>();
        for (Zone zone : zones.values()) {
            if (zone.contains(world, x, y, z)) result.add(zone);
        }
        return result;
    }

    /** 指定ゾーンと重なる既存ゾーン一覧 */
    public List<Zone> getOverlapping(Zone candidate) {
        List<Zone> result = new ArrayList<>();
        for (Zone zone : zones.values()) {
            if (!zone.getName().equalsIgnoreCase(candidate.getName()) && zone.overlaps(candidate)) {
                result.add(zone);
            }
        }
        return result;
    }

    /** 販売中のゾーン一覧 */
    public List<Zone> getForSaleZones() {
        List<Zone> result = new ArrayList<>();
        for (Zone zone : zones.values()) {
            if (zone.isForSale()) result.add(zone);
        }
        return result;
    }

    /** プレイヤーが所有するゾーン一覧 */
    public List<Zone> getZonesByOwner(String uuid) {
        List<Zone> result = new ArrayList<>();
        for (Zone zone : zones.values()) {
            if (uuid.equals(zone.getOwnerUuid())) result.add(zone);
        }
        return result;
    }
}
