package com.dynamicmarket;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

import java.util.List;

public class MarketCommand implements CommandExecutor {
    private final DynamicMarket plugin;
    private final MarketManager manager;
    private final MarketGUI gui;

    public MarketCommand(DynamicMarket plugin, MarketManager manager, MarketGUI gui) {
        this.plugin = plugin;
        this.manager = manager;
        this.gui = gui;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        // Internal Discord bridge: /mkt-discord <txId> <action> <player> [item] [qty]
        if (cmd.getName().equalsIgnoreCase("mkt-discord")) {
            handleDiscordBridge(args);
            return true;
        }

        // /market (no args) or /market gui — open inventory GUI
        if (args.length == 0 || args[0].equalsIgnoreCase("gui") || args[0].equalsIgnoreCase("shop")) {
            if (!(sender instanceof Player player)) {
                sender.sendMessage("§cプレイヤーのみ使用できます。");
                return true;
            }
            gui.openMarket(player, 0);
            return true;
        }

        return switch (args[0].toLowerCase()) {
            case "buy"  -> handleBuy(sender, args);
            case "sell" -> handleSell(sender, args);
            case "price" -> handlePrice(sender, args);
            case "list"  -> handleList(sender, args);
            default      -> { showHelp(sender); yield true; }
        };
    }

    // ─── /market buy <item> <qty> ──────────────────────────────────────────────

    private boolean handleBuy(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) { sender.sendMessage("§cプレイヤーのみ使用できます。"); return true; }
        if (args.length < 3) { player.sendMessage("§c使用方法: /market buy <アイテムID> <数量>"); return true; }
        try {
            int qty = Integer.parseInt(args[2]);
            TransactionResult r = manager.buy(player, args[1].toLowerCase(), qty);
            player.sendMessage(r.getMessage());
            if (r.isSuccess()) player.sendMessage(String.format("§7新しい相場: §e$%.4f", r.getNewItemPrice()));
        } catch (NumberFormatException e) {
            player.sendMessage("§c数量は整数で指定してください。");
        }
        return true;
    }

    // ─── /market sell <item> <qty> ─────────────────────────────────────────────

    private boolean handleSell(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) { sender.sendMessage("§cプレイヤーのみ使用できます。"); return true; }
        if (args.length < 3) { player.sendMessage("§c使用方法: /market sell <アイテムID> <数量>"); return true; }
        try {
            int qty = Integer.parseInt(args[2]);
            TransactionResult r = manager.sell(player, args[1].toLowerCase(), qty);
            player.sendMessage(r.getMessage());
            if (r.isSuccess()) player.sendMessage(String.format("§7新しい相場: §e$%.4f", r.getNewItemPrice()));
        } catch (NumberFormatException e) {
            player.sendMessage("§c数量は整数で指定してください。");
        }
        return true;
    }

    // ─── /market price <item> ──────────────────────────────────────────────────

    private boolean handlePrice(CommandSender sender, String[] args) {
        if (args.length < 2) { sender.sendMessage("§c使用方法: /market price <アイテムID>"); return true; }
        MarketItem mi = manager.getItem(args[1].toLowerCase());
        if (mi == null) { sender.sendMessage("§cアイテムが見つかりません: " + args[1]); return true; }

        sender.sendMessage(String.format("§6[%s] §f現在値: §e$%.4f §7%s §e%+.2f%%",
            mi.getDisplayName(), mi.getCurrentPrice(), mi.getPriceTrend(), mi.getPriceChangePercent()));
        sender.sendMessage(String.format("§7基準値: §e$%.4f §7| 購入(×1): §e$%.4f §7| 売却(×1): §e$%.4f",
            mi.getBasePrice(),
            manager.getEngine().getBuyCost(mi.getCurrentPrice(), 1),
            manager.getEngine().getSellRevenue(mi.getCurrentPrice(), 1)));
        return true;
    }

    // ─── /market list [page] ───────────────────────────────────────────────────

    private boolean handleList(CommandSender sender, String[] args) {
        int page = 0;
        if (args.length >= 2) {
            try { page = Integer.parseInt(args[1]) - 1; } catch (NumberFormatException ignored) {}
        }
        List<MarketItem> items = manager.getAllItems();
        int perPage = 10;
        int totalPages = Math.max(1, (int) Math.ceil((double) items.size() / perPage));
        page = Math.max(0, Math.min(page, totalPages - 1));

        sender.sendMessage("§6===== マーケット一覧 §e(" + (page + 1) + "§6/§e" + totalPages + "§6) =====");
        int start = page * perPage;
        for (int i = start; i < Math.min(start + perPage, items.size()); i++) {
            MarketItem mi = items.get(i);
            sender.sendMessage(String.format("§7%s §f%s §e$%.4f §7%s §e%+.1f%%",
                mi.getItemKey(), mi.getDisplayName(),
                mi.getCurrentPrice(), mi.getPriceTrend(), mi.getPriceChangePercent()));
        }
        sender.sendMessage("§7/market list <ページ番号> で次のページへ");
        return true;
    }

    // ─── Discord bridge: /mkt-discord <txId> <action> <player> [item] [qty] ───

    private void handleDiscordBridge(String[] args) {
        if (args.length < 3) {
            output("[MARKET_RESULT] ERR FAIL 引数不足");
            return;
        }

        String txId   = args[0];
        String action = args[1].toLowerCase();
        String targetName = args[2];

        // price and list don't need the server — just DB reads, handle in NodeJS.
        // But if called here, proxy them.
        if (action.equals("price")) {
            if (args.length < 4) { output("[MARKET_RESULT] " + txId + " FAIL 引数不足 (item)"); return; }
            MarketItem mi = manager.getItem(args[3].toLowerCase());
            if (mi == null) {
                output("[MARKET_RESULT] " + txId + " FAIL アイテムが見つかりません: " + args[3]);
            } else {
                output(String.format("[MARKET_RESULT] %s OK **%s** 現在値: $%.4f (%+.1f%%) 購入: $%.4f / 売却: $%.4f",
                    txId, mi.getDisplayName(), mi.getCurrentPrice(), mi.getPriceChangePercent(),
                    manager.getEngine().getBuyCost(mi.getCurrentPrice(), 1),
                    manager.getEngine().getSellRevenue(mi.getCurrentPrice(), 1)));
            }
            return;
        }

        if (action.equals("list")) {
            List<MarketItem> items = manager.getAllItems();
            StringBuilder sb = new StringBuilder("[MARKET_RESULT] " + txId + " LIST");
            for (MarketItem mi : items.subList(0, Math.min(10, items.size()))) {
                sb.append("|").append(mi.getDisplayName()).append(":$")
                  .append(String.format("%.2f", mi.getCurrentPrice()));
            }
            output(sb.toString());
            return;
        }

        // buy / sell — require player online and item/qty args
        if (args.length < 5) { output("[MARKET_RESULT] " + txId + " FAIL 引数不足 (item, qty)"); return; }

        Player target = Bukkit.getPlayerExact(targetName);
        if (target == null) {
            output("[MARKET_RESULT] " + txId + " FAIL プレイヤーがオフラインです: " + targetName);
            return;
        }

        String itemKey = args[3].toLowerCase();
        int qty;
        try {
            qty = Integer.parseInt(args[4]);
        } catch (NumberFormatException e) {
            output("[MARKET_RESULT] " + txId + " FAIL 数量が無効です");
            return;
        }

        final Player finalTarget = target;
        final int finalQty = qty;
        Bukkit.getScheduler().runTask(plugin, () -> {
            TransactionResult result = action.equals("buy")
                ? manager.buy(finalTarget, itemKey, finalQty)
                : action.equals("sell")
                    ? manager.sell(finalTarget, itemKey, finalQty)
                    : TransactionResult.fail("不明なアクション: " + action);

            finalTarget.sendMessage("§6[Discord Market] §f" + result.getMessage());
            String status = result.isSuccess() ? "OK" : "FAIL";
            String detail = ChatColor.stripColor(result.getMessage());
            if (result.isSuccess()) detail += String.format(" 新相場: $%.4f", result.getNewItemPrice());
            output("[MARKET_RESULT] " + txId + " " + status + " " + detail);
        });
    }

    /** Print to stdout so the Node.js bot can capture [MARKET_RESULT] lines. */
    private void output(String line) {
        System.out.println(line);
    }

    private void showHelp(CommandSender sender) {
        sender.sendMessage("§6===== Dynamic Market ヘルプ =====");
        sender.sendMessage("§e/market gui §7- GUIショップを開く");
        sender.sendMessage("§e/market list [ページ] §7- アイテム一覧");
        sender.sendMessage("§e/market price <ID> §7- 価格確認");
        sender.sendMessage("§e/market buy <ID> <数量> §7- 購入");
        sender.sendMessage("§e/market sell <ID> <数量> §7- 売却");
    }
}
