package com.dynamicmarket;

import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;

import java.util.*;

public class MarketGUI implements Listener {
    private final DynamicMarket plugin;
    private final MarketManager manager;

    // playerUUID -> current page in main market GUI
    private final Map<UUID, Integer> openPages = new HashMap<>();
    // playerUUID -> pending trade context for quantity selector
    private record QtyContext(String itemKey, boolean isBuy) {}
    private final Map<UUID, QtyContext> pendingTrades = new HashMap<>();

    private static final int ITEMS_PER_PAGE = 45;
    private static final int[] QTY_SLOTS    = {10, 11, 12, 13, 14};
    private static final int[] QTY_OPTIONS  = {1, 8, 16, 32, 64};

    public MarketGUI(DynamicMarket plugin, MarketManager manager) {
        this.plugin = plugin;
        this.manager = manager;
    }

    // ─────────────────── Open / build GUIs ───────────────────

    public void openMarket(Player player, int page) {
        List<MarketItem> items = manager.getAllItems();
        int totalPages = Math.max(1, (int) Math.ceil((double) items.size() / ITEMS_PER_PAGE));
        page = Math.max(0, Math.min(page, totalPages - 1));

        Inventory inv = Bukkit.createInventory(null, 54,
            "§6§lDynamic Market §7(§e" + (page + 1) + "§7/§e" + totalPages + "§7)");

        int start = page * ITEMS_PER_PAGE;
        for (int i = start; i < Math.min(start + ITEMS_PER_PAGE, items.size()); i++) {
            inv.setItem(i - start, buildItemDisplay(items.get(i)));
        }

        // Bottom navigation row
        inv.setItem(45, icon(Material.ARROW,   "§7§l◀ 前ページ",  List.of()));
        inv.setItem(49, icon(Material.PAPER,    "§e§lページ情報",
            List.of("§7現在: §e" + (page + 1) + " §7/ §e" + totalPages,
                    "§7総アイテム数: §e" + items.size(),
                    "", "§7§o左クリック: 購入  右クリック: 売却")));
        inv.setItem(52, icon(Material.BARRIER,  "§c閉じる",       List.of()));
        inv.setItem(53, icon(Material.ARROW,    "§7§l次ページ ▶", List.of()));

        openPages.put(player.getUniqueId(), page);
        player.openInventory(inv);
    }

    private void openQuantitySelector(Player player, MarketItem item, boolean isBuy) {
        String label = isBuy ? "§a購入" : "§c売却";
        Inventory inv = Bukkit.createInventory(null, 27, label + "§7: §f" + item.getDisplayName());

        for (int i = 0; i < QTY_OPTIONS.length; i++) {
            int qty = QTY_OPTIONS[i];
            double total = isBuy
                ? manager.getEngine().getBuyCost(item.getCurrentPrice(), qty)
                : manager.getEngine().getSellRevenue(item.getCurrentPrice(), qty);

            Material glass = isBuy ? Material.LIME_STAINED_GLASS_PANE : Material.RED_STAINED_GLASS_PANE;
            inv.setItem(QTY_SLOTS[i], icon(glass, label + " §f×" + qty,
                List.of("§7数量: §e" + qty,
                        "§7合計: §e$" + String.format("%.2f", total),
                        "§7単価: §e$" + String.format("%.4f", total / qty),
                        "",
                        "§aクリックして確定")));
        }
        inv.setItem(22, icon(Material.ARROW, "§7§l◀ 戻る", List.of()));

        pendingTrades.put(player.getUniqueId(), new QtyContext(item.getItemKey(), isBuy));
        player.openInventory(inv);
    }

    // ─────────────────── Event handlers ───────────────────────

    @EventHandler
    public void onInventoryClick(InventoryClickEvent e) {
        if (!(e.getWhoClicked() instanceof Player player)) return;
        e.setCancelled(true);

        String title = e.getView().getTitle();
        UUID uuid = player.getUniqueId();
        int slot = e.getRawSlot();

        // ── Main market GUI ──
        if (title.startsWith("§6§lDynamic Market")) {
            int page = openPages.getOrDefault(uuid, 0);

            if (slot >= 0 && slot < ITEMS_PER_PAGE) {
                List<MarketItem> items = manager.getAllItems();
                int idx = page * ITEMS_PER_PAGE + slot;
                if (idx < items.size()) {
                    MarketItem mi = items.get(idx);
                    boolean isBuy = !e.isRightClick();
                    player.closeInventory();
                    Bukkit.getScheduler().runTask(plugin,
                        () -> openQuantitySelector(player, mi, isBuy));
                }
            } else if (slot == 45) {
                player.closeInventory();
                Bukkit.getScheduler().runTask(plugin, () -> openMarket(player, page - 1));
            } else if (slot == 53) {
                player.closeInventory();
                Bukkit.getScheduler().runTask(plugin, () -> openMarket(player, page + 1));
            } else if (slot == 52) {
                openPages.remove(uuid);
                player.closeInventory();
            }
            return;
        }

        // ── Quantity selector GUI ──
        if ((title.startsWith("§a購入§7:") || title.startsWith("§c売却§7:"))
                && pendingTrades.containsKey(uuid)) {

            QtyContext ctx = pendingTrades.get(uuid);

            if (slot == 22) { // back button
                pendingTrades.remove(uuid);
                player.closeInventory();
                Bukkit.getScheduler().runTask(plugin,
                    () -> openMarket(player, openPages.getOrDefault(uuid, 0)));
                return;
            }

            for (int i = 0; i < QTY_SLOTS.length; i++) {
                if (slot == QTY_SLOTS[i]) {
                    final int qty = QTY_OPTIONS[i];
                    pendingTrades.remove(uuid);
                    player.closeInventory();
                    Bukkit.getScheduler().runTask(plugin, () -> {
                        MarketItem mi = manager.getItem(ctx.itemKey());
                        if (mi == null) { player.sendMessage("§cアイテムが見つかりません。"); return; }
                        TransactionResult result = ctx.isBuy()
                            ? manager.buy(player, ctx.itemKey(), qty)
                            : manager.sell(player, ctx.itemKey(), qty);
                        player.sendMessage(result.getMessage());
                        if (result.isSuccess()) {
                            player.sendMessage(String.format("§7新しい相場: §e$%.4f", result.getNewItemPrice()));
                        }
                    });
                    return;
                }
            }
        }
    }

    @EventHandler
    public void onInventoryClose(InventoryCloseEvent e) {
        if (!(e.getPlayer() instanceof Player player)) return;
        // Cleanup only if not navigating (task was already scheduled)
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            if (!openPages.containsKey(player.getUniqueId())
                    && !pendingTrades.containsKey(player.getUniqueId())) return;
            // still in a GUI flow — don't purge
        }, 2L);
    }

    // ─────────────────── Helpers ──────────────────────────────

    private ItemStack buildItemDisplay(MarketItem mi) {
        Material mat;
        ItemStack resolved = manager.resolveItem(mi.getItemKey(), 1);
        mat = (resolved != null) ? resolved.getType() : Material.PAPER;

        double change = mi.getPriceChangePercent();
        String trend  = mi.getPriceTrend();

        List<String> lore = new ArrayList<>();
        lore.add("§8" + mi.getItemKey());
        lore.add("§7現在値: §e$" + String.format("%.4f", mi.getCurrentPrice()));
        lore.add("§7基準値: §7$" + String.format("%.4f", mi.getBasePrice()));
        lore.add("§7変動: " + trend + String.format(" %+.1f%%", change));
        lore.add("§7購入数: §e" + mi.getTotalBought() + "  §7売却数: §e" + mi.getTotalSold());
        lore.add("");
        lore.add("§a左クリック§7: 購入   §c右クリック§7: 売却");

        return icon(mat, "§f§l" + mi.getDisplayName(), lore);
    }

    private ItemStack icon(Material mat, String name, List<String> lore) {
        ItemStack stack = new ItemStack(mat);
        ItemMeta meta  = stack.getItemMeta();
        meta.setDisplayName(name);
        meta.setLore(new ArrayList<>(lore));
        stack.setItemMeta(meta);
        return stack;
    }
}
