package com.dynamicmarket;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;

public class AdminCommand implements CommandExecutor {
    private final DynamicMarket plugin;
    private final MarketManager manager;
    private final MarketDB db;

    public AdminCommand(DynamicMarket plugin, MarketManager manager, MarketDB db) {
        this.plugin = plugin;
        this.manager = manager;
        this.db = db;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (!sender.hasPermission("dynamicmarket.admin")) {
            sender.sendMessage("§c権限がありません。");
            return true;
        }
        if (args.length == 0) { showHelp(sender); return true; }

        return switch (args[0].toLowerCase()) {
            case "additem"    -> doAddItem(sender, args);
            case "setprice", "setbase" -> doSetPrice(sender, args);
            case "setcurrent" -> doSetCurrent(sender, args);
            case "enable"     -> doToggle(sender, args, true);
            case "disable"    -> doToggle(sender, args, false);
            case "info"       -> doInfo(sender, args);
            case "list"       -> doList(sender);
            case "reload"     -> doReload(sender);
            default           -> { showHelp(sender); yield true; }
        };
    }

    // /mktadmin additem <ID> <表示名> <基準値>
    private boolean doAddItem(CommandSender sender, String[] args) {
        if (args.length < 4) { sender.sendMessage("§c使用方法: /mktadmin additem <ID> <表示名> <基準値>"); return true; }
        String key  = args[1].toLowerCase();
        String name = args[2];
        try {
            double price = Double.parseDouble(args[3]);
            manager.registerItem(key, name, price);
            sender.sendMessage("§a登録しました: §f" + name + " §8(" + key + ") §e$" + price);
        } catch (NumberFormatException e) {
            sender.sendMessage("§c価格は数値で入力してください。");
        }
        return true;
    }

    // /mktadmin setprice <ID> <新基準値>
    private boolean doSetPrice(CommandSender sender, String[] args) {
        if (args.length < 3) { sender.sendMessage("§c使用方法: /mktadmin setprice <ID> <新基準値>"); return true; }
        try {
            double price = Double.parseDouble(args[2]);
            manager.setBasePrice(args[1].toLowerCase(), price);
            sender.sendMessage("§a基準値を更新しました: §f" + args[1] + " §7→ §e$" + price);
        } catch (NumberFormatException e) {
            sender.sendMessage("§c価格は数値で入力してください。");
        }
        return true;
    }

    // /mktadmin setcurrent <ID> <現在値> — direct override without triggering decay
    private boolean doSetCurrent(CommandSender sender, String[] args) {
        if (args.length < 3) { sender.sendMessage("§c使用方法: /mktadmin setcurrent <ID> <現在値>"); return true; }
        try {
            double price = Double.parseDouble(args[2]);
            db.updatePriceOnly(args[1].toLowerCase(), price);
            sender.sendMessage("§a現在値を設定しました: §f" + args[1] + " §7→ §e$" + price);
        } catch (NumberFormatException e) {
            sender.sendMessage("§c価格は数値で入力してください。");
        }
        return true;
    }

    private boolean doToggle(CommandSender sender, String[] args, boolean enable) {
        if (args.length < 2) {
            sender.sendMessage("§c使用方法: /mktadmin " + (enable ? "enable" : "disable") + " <ID>");
            return true;
        }
        db.setEnabled(args[1].toLowerCase(), enable);
        sender.sendMessage((enable ? "§aアイテムを有効化しました: " : "§cアイテムを無効化しました: ") + "§f" + args[1]);
        return true;
    }

    private boolean doInfo(CommandSender sender, String[] args) {
        if (args.length < 2) { sender.sendMessage("§c使用方法: /mktadmin info <ID>"); return true; }
        MarketItem mi = manager.getItem(args[1].toLowerCase());
        if (mi == null) { sender.sendMessage("§cアイテムが見つかりません。"); return true; }

        sender.sendMessage("§6=== " + mi.getDisplayName() + " ===");
        sender.sendMessage("§7ID: §f"       + mi.getItemKey());
        sender.sendMessage("§7基準値: §e$"  + mi.getBasePrice());
        sender.sendMessage("§7現在値: §e$"  + mi.getCurrentPrice());
        sender.sendMessage(String.format("§7変動: §e%+.2f%%", mi.getPriceChangePercent()));
        sender.sendMessage("§7総購入数: §e" + mi.getTotalBought());
        sender.sendMessage("§7総売却数: §e" + mi.getTotalSold());
        sender.sendMessage("§7有効: " + (mi.isEnabled() ? "§aはい" : "§cいいえ"));
        return true;
    }

    private boolean doList(CommandSender sender) {
        sender.sendMessage("§6=== 登録アイテム一覧 ===");
        for (MarketItem mi : manager.getAllItems()) {
            sender.sendMessage(String.format("§7%s §f%s §e$%.4f §7%s §e%+.1f%%",
                mi.getItemKey(), mi.getDisplayName(),
                mi.getCurrentPrice(), mi.getPriceTrend(), mi.getPriceChangePercent()));
        }
        return true;
    }

    private boolean doReload(CommandSender sender) {
        plugin.reloadConfig();
        manager.getEngine().loadConfig();
        sender.sendMessage("§aコンフィグをリロードしました。");
        return true;
    }

    private void showHelp(CommandSender sender) {
        sender.sendMessage("§6===== Market Admin ヘルプ =====");
        sender.sendMessage("§e/mktadmin additem <ID> <名前> <基準値> §7- アイテム登録");
        sender.sendMessage("§e/mktadmin setprice <ID> <基準値>     §7- 基準値を変更");
        sender.sendMessage("§e/mktadmin setcurrent <ID> <現在値>   §7- 現在値を直接設定");
        sender.sendMessage("§e/mktadmin enable/disable <ID>        §7- 有効/無効切替");
        sender.sendMessage("§e/mktadmin info <ID>                  §7- アイテム詳細");
        sender.sendMessage("§e/mktadmin list                       §7- 全アイテム一覧");
        sender.sendMessage("§e/mktadmin reload                     §7- コンフィグリロード");
    }
}
