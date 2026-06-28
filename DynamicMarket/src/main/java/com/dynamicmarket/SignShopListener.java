package com.dynamicmarket;

import org.bukkit.ChatColor;
import org.bukkit.block.Sign;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.SignChangeEvent;
import org.bukkit.event.player.PlayerInteractEvent;

/**
 * DynMarket sign shop.
 *
 * Sign layout:
 *   Line 0: [DynMarket]
 *   Line 1: BUY  or  SELL
 *   Line 2: item_key  (e.g. minecraft:diamond)
 *   Line 3: quantity  (positive integer)
 */
public class SignShopListener implements Listener {
    private final DynamicMarket plugin;
    private final MarketManager manager;

    private static final String HEADER = "[DynMarket]";

    public SignShopListener(DynamicMarket plugin, MarketManager manager) {
        this.plugin = plugin;
        this.manager = manager;
    }

    @EventHandler
    public void onSignCreate(SignChangeEvent e) {
        if (!e.getLine(0).equalsIgnoreCase(HEADER)) return;

        Player player = e.getPlayer();
        if (!player.hasPermission("dynamicmarket.sign.create")) {
            player.sendMessage("§cサインを作成する権限がありません。");
            e.setCancelled(true);
            return;
        }

        String action = e.getLine(1).trim().toUpperCase();
        if (!action.equals("BUY") && !action.equals("SELL")) {
            player.sendMessage("§c2行目は §eBUY §cまたは §eSELL §cを入力してください。");
            e.setCancelled(true);
            return;
        }

        String itemKey = e.getLine(2).trim().toLowerCase();
        if (manager.getItem(itemKey) == null) {
            player.sendMessage("§cアイテム §f" + itemKey + " §cは市場に登録されていません。");
            e.setCancelled(true);
            return;
        }

        try {
            int qty = Integer.parseInt(e.getLine(3).trim());
            if (qty < 1) throw new NumberFormatException();
        } catch (NumberFormatException ex) {
            player.sendMessage("§c4行目には §e1以上の整数 §cを入力してください。");
            e.setCancelled(true);
            return;
        }

        // Format lines with color
        e.setLine(0, ChatColor.DARK_AQUA + HEADER);
        e.setLine(1, action.equals("BUY") ? ChatColor.GREEN + "BUY" : ChatColor.RED + "SELL");
        e.setLine(2, itemKey);
        e.setLine(3, e.getLine(3).trim());
        player.sendMessage("§aマーケットサインを作成しました！");
    }

    @EventHandler
    public void onSignInteract(PlayerInteractEvent e) {
        if (e.getAction() != Action.RIGHT_CLICK_BLOCK) return;
        if (e.getClickedBlock() == null) return;
        if (!(e.getClickedBlock().getState() instanceof Sign sign)) return;

        String[] lines = sign.getLines();
        if (!ChatColor.stripColor(lines[0]).equals(HEADER)) return;

        e.setCancelled(true);
        Player player = e.getPlayer();

        String action  = ChatColor.stripColor(lines[1]).trim().toUpperCase();
        String itemKey = ChatColor.stripColor(lines[2]).trim().toLowerCase();
        int qty;
        try {
            qty = Integer.parseInt(ChatColor.stripColor(lines[3]).trim());
        } catch (NumberFormatException ex) {
            player.sendMessage("§cサインの数量が無効です。");
            return;
        }

        TransactionResult result = switch (action) {
            case "BUY"  -> manager.buy(player, itemKey, qty);
            case "SELL" -> manager.sell(player, itemKey, qty);
            default -> TransactionResult.fail("§cサインのアクション §f" + action + " §cが無効です。");
        };

        player.sendMessage(result.getMessage());
        if (result.isSuccess()) {
            player.sendMessage(String.format("§7新しい相場: §e$%.4f", result.getNewItemPrice()));
        }
    }
}
