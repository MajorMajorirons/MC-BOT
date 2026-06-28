package com.dynamicmarket;

import java.io.File;
import java.sql.*;
import java.util.ArrayList;
import java.util.List;

public class MarketDB {
    private final DynamicMarket plugin;
    private Connection conn;

    public MarketDB(DynamicMarket plugin) {
        this.plugin = plugin;
    }

    public void initialize() {
        try {
            Class.forName("org.sqlite.JDBC");
            plugin.getDataFolder().mkdirs();
            File dbFile = new File(plugin.getDataFolder(), "market.db");
            conn = DriverManager.getConnection("jdbc:sqlite:" + dbFile.getAbsolutePath());
            conn.setAutoCommit(true);

            try (Statement s = conn.createStatement()) {
                s.execute("""
                    CREATE TABLE IF NOT EXISTS market_items (
                        item_key      TEXT PRIMARY KEY,
                        display_name  TEXT NOT NULL,
                        base_price    REAL NOT NULL,
                        current_price REAL NOT NULL,
                        total_bought  INTEGER DEFAULT 0,
                        total_sold    INTEGER DEFAULT 0,
                        last_updated  INTEGER NOT NULL,
                        enabled       INTEGER DEFAULT 1
                    )
                    """);
                s.execute("""
                    CREATE TABLE IF NOT EXISTS price_history (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        item_key   TEXT NOT NULL,
                        price      REAL NOT NULL,
                        timestamp  INTEGER NOT NULL,
                        type       TEXT NOT NULL,
                        quantity   INTEGER NOT NULL,
                        player     TEXT NOT NULL
                    )
                    """);
                s.execute("CREATE INDEX IF NOT EXISTS idx_history_item ON price_history(item_key, timestamp DESC)");
            }
            plugin.getLogger().info("Database initialized: " + dbFile.getAbsolutePath());
        } catch (Exception e) {
            plugin.getLogger().severe("DB init failed: " + e.getMessage());
        }
    }

    public List<MarketItem> getAllItems() {
        List<MarketItem> list = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT * FROM market_items WHERE enabled=1 ORDER BY item_key")) {
            ResultSet rs = ps.executeQuery();
            while (rs.next()) list.add(map(rs));
        } catch (SQLException e) {
            plugin.getLogger().severe("getAllItems: " + e.getMessage());
        }
        return list;
    }

    public MarketItem getItem(String key) {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT * FROM market_items WHERE item_key=?")) {
            ps.setString(1, key.toLowerCase());
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return map(rs);
        } catch (SQLException e) {
            plugin.getLogger().severe("getItem: " + e.getMessage());
        }
        return null;
    }

    public void upsertItem(String key, String displayName, double basePrice) {
        try (PreparedStatement ps = conn.prepareStatement("""
                INSERT INTO market_items (item_key, display_name, base_price, current_price, last_updated)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(item_key) DO UPDATE SET
                    display_name=excluded.display_name,
                    base_price=excluded.base_price,
                    last_updated=excluded.last_updated
                """)) {
            ps.setString(1, key.toLowerCase());
            ps.setString(2, displayName);
            ps.setDouble(3, basePrice);
            ps.setDouble(4, basePrice);
            ps.setLong(5, System.currentTimeMillis());
            ps.executeUpdate();
        } catch (SQLException e) {
            plugin.getLogger().severe("upsertItem: " + e.getMessage());
        }
    }

    public void setBasePrice(String key, double basePrice) {
        try (PreparedStatement ps = conn.prepareStatement(
                "UPDATE market_items SET base_price=?, last_updated=? WHERE item_key=?")) {
            ps.setDouble(1, basePrice);
            ps.setLong(2, System.currentTimeMillis());
            ps.setString(3, key.toLowerCase());
            ps.executeUpdate();
        } catch (SQLException e) {
            plugin.getLogger().severe("setBasePrice: " + e.getMessage());
        }
    }

    public void updateAfterTransaction(String key, double newPrice, int boughtDelta, int soldDelta) {
        try (PreparedStatement ps = conn.prepareStatement("""
                UPDATE market_items SET
                    current_price=?,
                    total_bought=total_bought+?,
                    total_sold=total_sold+?,
                    last_updated=?
                WHERE item_key=?
                """)) {
            ps.setDouble(1, newPrice);
            ps.setInt(2, boughtDelta);
            ps.setInt(3, soldDelta);
            ps.setLong(4, System.currentTimeMillis());
            ps.setString(5, key.toLowerCase());
            ps.executeUpdate();
        } catch (SQLException e) {
            plugin.getLogger().severe("updateAfterTransaction: " + e.getMessage());
        }
    }

    public void updatePriceOnly(String key, double newPrice) {
        try (PreparedStatement ps = conn.prepareStatement(
                "UPDATE market_items SET current_price=?, last_updated=? WHERE item_key=?")) {
            ps.setDouble(1, newPrice);
            ps.setLong(2, System.currentTimeMillis());
            ps.setString(3, key.toLowerCase());
            ps.executeUpdate();
        } catch (SQLException e) {
            plugin.getLogger().severe("updatePriceOnly: " + e.getMessage());
        }
    }

    public void logTransaction(String key, double priceAtTime, String type, int qty, String player) {
        try (PreparedStatement ps = conn.prepareStatement("""
                INSERT INTO price_history (item_key, price, timestamp, type, quantity, player)
                VALUES (?, ?, ?, ?, ?, ?)
                """)) {
            ps.setString(1, key.toLowerCase());
            ps.setDouble(2, priceAtTime);
            ps.setLong(3, System.currentTimeMillis());
            ps.setString(4, type);
            ps.setInt(5, qty);
            ps.setString(6, player);
            ps.executeUpdate();
        } catch (SQLException e) {
            plugin.getLogger().severe("logTransaction: " + e.getMessage());
        }
    }

    public void setEnabled(String key, boolean enabled) {
        try (PreparedStatement ps = conn.prepareStatement(
                "UPDATE market_items SET enabled=? WHERE item_key=?")) {
            ps.setInt(1, enabled ? 1 : 0);
            ps.setString(2, key.toLowerCase());
            ps.executeUpdate();
        } catch (SQLException e) {
            plugin.getLogger().severe("setEnabled: " + e.getMessage());
        }
    }

    public void close() {
        try {
            if (conn != null && !conn.isClosed()) conn.close();
        } catch (SQLException e) {
            plugin.getLogger().severe("DB close: " + e.getMessage());
        }
    }

    private MarketItem map(ResultSet rs) throws SQLException {
        return new MarketItem(
            rs.getString("item_key"),
            rs.getString("display_name"),
            rs.getDouble("base_price"),
            rs.getDouble("current_price"),
            rs.getInt("total_bought"),
            rs.getInt("total_sold"),
            rs.getLong("last_updated"),
            rs.getInt("enabled") == 1
        );
    }
}
