package com.dynamicmarket;

import net.milkbowl.vault.economy.Economy;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;

import java.util.List;

public class MarketManager {
    private final DynamicMarket plugin;
    private final MarketDB db;
    private final PriceEngine engine;
    private final Economy eco;

    public MarketManager(DynamicMarket plugin, MarketDB db, PriceEngine engine, Economy eco) {
        this.plugin = plugin;
        this.db = db;
        this.engine = engine;
        this.eco = eco;
    }

    public TransactionResult buy(Player player, String itemKey, int qty) {
        if (qty < 1) return TransactionResult.fail(msg("messages.invalid-quantity"));

        MarketItem item = db.getItem(itemKey);
        if (item == null) return TransactionResult.fail(msg("messages.item-not-found").replace("{item}", itemKey));

        double totalCost = engine.getBuyCost(item.getCurrentPrice(), qty);
        double balance = eco.getBalance(player);

        if (balance < totalCost) {
            return TransactionResult.fail(msg("messages.not-enough-money")
                .replace("{needed}", String.format("%.2f", totalCost))
                .replace("{balance}", String.format("%.2f", balance)));
        }

        ItemStack stack = resolveItem(itemKey, qty);
        if (stack == null) return TransactionResult.fail("§cアイテムを生成できませんでした: " + itemKey);

        eco.withdrawPlayer(player, totalCost);
        giveItems(player, stack);

        double newPrice = engine.calcNewPrice(item.getCurrentPrice(), item.getBasePrice(), qty, true);
        db.updateAfterTransaction(itemKey, newPrice, qty, 0);
        db.logTransaction(itemKey, item.getCurrentPrice(), "BUY", qty, player.getName());

        String message = msg("messages.buy-success")
            .replace("{item}", item.getDisplayName())
            .replace("{qty}", String.valueOf(qty))
            .replace("{price}", String.format("%.2f", totalCost));
        return TransactionResult.success(message, totalCost, newPrice);
    }

    public TransactionResult sell(Player player, String itemKey, int qty) {
        if (qty < 1) return TransactionResult.fail(msg("messages.invalid-quantity"));

        MarketItem item = db.getItem(itemKey);
        if (item == null) return TransactionResult.fail(msg("messages.item-not-found").replace("{item}", itemKey));

        ItemStack sampleStack = resolveItem(itemKey, 1);
        if (sampleStack == null) return TransactionResult.fail("§cアイテムを解決できませんでした: " + itemKey);

        int playerHas = countItems(player, sampleStack.getType());
        if (playerHas < qty) {
            return TransactionResult.fail(msg("messages.not-enough-items")
                .replace("{item}", item.getDisplayName())
                .replace("{needed}", String.valueOf(qty))
                .replace("{have}", String.valueOf(playerHas)));
        }

        double revenue = engine.getSellRevenue(item.getCurrentPrice(), qty);
        removeItems(player, sampleStack.getType(), qty);
        eco.depositPlayer(player, revenue);

        double newPrice = engine.calcNewPrice(item.getCurrentPrice(), item.getBasePrice(), qty, false);
        db.updateAfterTransaction(itemKey, newPrice, 0, qty);
        db.logTransaction(itemKey, item.getCurrentPrice(), "SELL", qty, player.getName());

        String message = msg("messages.sell-success")
            .replace("{item}", item.getDisplayName())
            .replace("{qty}", String.valueOf(qty))
            .replace("{price}", String.format("%.2f", revenue));
        return TransactionResult.success(message, revenue, newPrice);
    }

    /** Called periodically to push all prices toward their base values. */
    public void applyPriceDecay() {
        long now = System.currentTimeMillis();
        for (MarketItem item : db.getAllItems()) {
            long elapsed = now - item.getLastUpdated();
            if (elapsed < 5000) continue; // skip items updated < 5s ago
            double newPrice = engine.applyDecay(item.getCurrentPrice(), item.getBasePrice(), elapsed);
            if (Math.abs(newPrice - item.getCurrentPrice()) > 0.0001) {
                db.updatePriceOnly(item.getItemKey(), newPrice);
            }
        }
    }

    public List<MarketItem> getAllItems() { return db.getAllItems(); }

    public MarketItem getItem(String key) { return db.getItem(key); }

    public void registerItem(String key, String displayName, double basePrice) {
        db.upsertItem(key, displayName, basePrice);
    }

    public void setBasePrice(String key, double basePrice) {
        db.setBasePrice(key, basePrice);
    }

    /**
     * Resolve a namespaced item key (e.g. "minecraft:diamond", "thermal:copper_ingot")
     * to a Bukkit ItemStack. Returns null for unknown/mod items that Bukkit can't resolve.
     */
    public ItemStack resolveItem(String itemKey, int qty) {
        try {
            NamespacedKey nsKey = NamespacedKey.fromString(itemKey.toLowerCase());
            if (nsKey == null) return null;
            Material mat = Material.matchMaterial(itemKey);
            if (mat == null || mat == Material.AIR) return null;
            return new ItemStack(mat, qty);
        } catch (Exception e) {
            return null;
        }
    }

    private int countItems(Player player, Material type) {
        int count = 0;
        for (ItemStack stack : player.getInventory().getContents()) {
            if (stack != null && stack.getType() == type) count += stack.getAmount();
        }
        return count;
    }

    private void giveItems(Player player, ItemStack stack) {
        int remaining = stack.getAmount();
        int maxStack = stack.getType().getMaxStackSize();
        while (remaining > 0) {
            int give = Math.min(remaining, maxStack);
            player.getInventory().addItem(new ItemStack(stack.getType(), give))
                .values().forEach(leftover -> player.getWorld().dropItem(player.getLocation(), leftover));
            remaining -= give;
        }
    }

    private void removeItems(Player player, Material type, int qty) {
        int remaining = qty;
        ItemStack[] contents = player.getInventory().getContents();
        for (int i = 0; i < contents.length && remaining > 0; i++) {
            ItemStack stack = contents[i];
            if (stack != null && stack.getType() == type) {
                int remove = Math.min(remaining, stack.getAmount());
                stack.setAmount(stack.getAmount() - remove);
                remaining -= remove;
            }
        }
        player.getInventory().setContents(contents);
    }

    public PriceEngine getEngine() { return engine; }
    public Economy getEco()        { return eco; }

    private String msg(String path) {
        return plugin.getConfig().getString(path, path);
    }
}
