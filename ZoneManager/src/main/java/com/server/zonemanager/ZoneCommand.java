package com.server.zonemanager;

import net.milkbowl.vault.economy.Economy;
import net.milkbowl.vault.economy.EconomyResponse;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.OfflinePlayer;
import org.bukkit.command.*;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;

import java.util.*;

public class ZoneCommand implements CommandExecutor {

    private static final ChatColor C  = ChatColor.AQUA;
    private static final ChatColor W  = ChatColor.YELLOW;
    private static final ChatColor E  = ChatColor.RED;
    private static final ChatColor G  = ChatColor.GREEN;
    private static final ChatColor GR = ChatColor.GRAY;
    private static final ChatColor GO = ChatColor.GOLD;

    private final ZoneStorage storage;
    private final Economy economy;
    private final Map<UUID, Location[]> selections;
    private final NamespacedKey wandKey;

    // 購入確認待ち: playerUUID -> [zone名, 有効期限]
    private final Map<UUID, String[]> pendingBuy = new HashMap<>();

    public ZoneCommand(ZoneStorage storage, Economy economy,
                       Map<UUID, Location[]> selections, NamespacedKey wandKey) {
        this.storage    = storage;
        this.economy    = economy;
        this.selections = selections;
        this.wandKey    = wandKey;
    }

    private boolean isAdmin(CommandSender s) {
        return s.hasPermission("zonemanager.admin");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) { sendHelp(sender); return true; }

        switch (args[0].toLowerCase()) {
            case "wand"      -> cmdWand(sender, args);
            case "claim"     -> cmdClaim(sender, args);
            case "unclaim"   -> cmdUnclaim(sender, args);
            case "explosion" -> cmdExplosion(sender, args);
            case "info"      -> cmdInfo(sender, args);
            case "list"      -> cmdList(sender, args);
            case "sell"      -> cmdSell(sender, args);
            case "unsell"    -> cmdUnsell(sender, args);
            case "buy"       -> cmdBuy(sender, args);
            case "forsale"   -> cmdForSale(sender, args);
            case "setowner"  -> cmdSetOwner(sender, args);
            case "adminzone" -> cmdAdminZone(sender, args);
            case "delete"    -> cmdDelete(sender, args);
            default          -> sendHelp(sender);
        }
        return true;
    }

    // ── ワンド付与 ────────────────────────────────────────────
    private void cmdWand(CommandSender sender, String[] args) {
        Player target;
        if (args.length >= 2 && isAdmin(sender)) {
            target = Bukkit.getPlayer(args[1]);
            if (target == null) { sender.sendMessage(E + "プレイヤー '" + args[1] + "' が見つかりません（オンラインのみ）"); return; }
        } else if (sender instanceof Player p) {
            target = p;
        } else {
            sender.sendMessage(E + "使い方: /zone wand [プレイヤー名]"); return;
        }

        ItemStack wand = new ItemStack(Material.GOLDEN_AXE);
        ItemMeta meta = wand.getItemMeta();
        meta.setDisplayName(GO + "✦ " + ChatColor.BOLD + "Zone Selection Wand");
        meta.setLore(List.of(
            GR + "左クリック" + ChatColor.WHITE + " でブロックを選択 → " + C + "座標1",
            GR + "右クリック" + ChatColor.WHITE + " でブロックを選択 → " + C + "座標2",
            "",
            GR + "両方設定後に " + G + "/zone claim <名前>" + GR + " で登録"
        ));
        meta.getPersistentDataContainer().set(wandKey, PersistentDataType.BYTE, (byte) 1);
        wand.setItemMeta(meta);

        target.getInventory().addItem(wand);

        if (target == sender) {
            target.sendMessage(GO + "✦ Zone Selection Wand " + GR + "を付与しました。");
            target.sendMessage(GR + "左クリック=座標1  右クリック=座標2  両方設定後に " + G + "/zone claim <名前>");
        } else {
            sender.sendMessage(G + target.getName() + " に Zone Selection Wand を付与しました。");
            target.sendMessage(GO + "✦ Zone Selection Wand " + GR + "を受け取りました。");
        }
    }

    // ── 土地登録（ワンド選択 or 座標直接指定） ────────────────
    private void cmdClaim(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) { sender.sendMessage(E + "プレイヤーのみ使用できます。"); return; }
        if (!sender.hasPermission("zonemanager.claim")) { player.sendMessage(E + "権限がありません。"); return; }
        if (args.length < 2) { player.sendMessage(E + "使い方: /zone claim <名前> [x1 y1 z1 x2 y2 z2]"); return; }

        String name = args[1];
        if (storage.getZone(name) != null) { player.sendMessage(E + "ゾーン名 '" + name + "' はすでに存在します。"); return; }

        int[] c;
        String worldName;

        if (args.length >= 8) {
            // 座標直接指定
            c = parseCoords(player, args, 2);
            if (c == null) return;
            worldName = player.getWorld().getName();
        } else {
            // ワンド選択から取得
            Location[] sel = selections.get(player.getUniqueId());
            if (sel == null || sel[0] == null || sel[1] == null) {
                player.sendMessage(E + "座標が選択されていません。");
                player.sendMessage(GR + "→ " + GO + "/zone wand " + GR + "でワンドを入手して左右クリックで範囲を選択してください。");
                return;
            }
            if (!sel[0].getWorld().equals(sel[1].getWorld())) {
                player.sendMessage(E + "座標1と座標2が別のワールドにあります。同じワールドで選択してください。"); return;
            }
            c = new int[]{
                sel[0].getBlockX(), sel[0].getBlockY(), sel[0].getBlockZ(),
                sel[1].getBlockX(), sel[1].getBlockY(), sel[1].getBlockZ()
            };
            worldName = sel[0].getWorld().getName();
        }

        Zone candidate = new Zone(name, worldName,
            c[0], c[1], c[2], c[3], c[4], c[5],
            player.getUniqueId().toString(), player.getName(), false, System.currentTimeMillis());

        List<Zone> overlapping = storage.getOverlapping(candidate);
        if (!overlapping.isEmpty()) {
            Zone conflict = overlapping.get(0);
            if (conflict.isAdminZone())
                player.sendMessage(E + "指定範囲は管理者ゾーン '" + conflict.getName() + "' と重なっています。");
            else
                player.sendMessage(E + "指定範囲は " + conflict.getOwnerName() + " 所有のゾーン '" + conflict.getName() + "' と重なっています。");
            return;
        }

        storage.addZone(candidate);
        selections.remove(player.getUniqueId());
        player.sendMessage(G + "ゾーン '" + name + "' を登録しました！");
        player.sendMessage(GR + "爆発保護: " + G + "/zone explosion " + name + " on");
    }

    // ── 土地解除 ──────────────────────────────────────────────
    private void cmdUnclaim(CommandSender sender, String[] args) {
        if (args.length < 2) { sender.sendMessage(E + "使い方: /zone unclaim <名前>"); return; }
        Zone zone = storage.getZone(args[1]);
        if (zone == null) { sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }
        if (!isAdmin(sender) && !(sender instanceof Player p && zone.isOwnedBy(p.getUniqueId().toString()))) {
            sender.sendMessage(E + "所有者または管理者のみ操作できます。"); return;
        }
        storage.removeZone(args[1]);
        sender.sendMessage(G + "ゾーン '" + args[1] + "' を削除しました。");
    }

    // ── 爆発保護 ──────────────────────────────────────────────
    private void cmdExplosion(CommandSender sender, String[] args) {
        if (args.length < 3) { sender.sendMessage(E + "使い方: /zone explosion <名前> <on|off>"); return; }
        Zone zone = storage.getZone(args[1]);
        if (zone == null) { sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }
        if (!isAdmin(sender) && !(sender instanceof Player p && zone.isOwnedBy(p.getUniqueId().toString()))) {
            sender.sendMessage(E + "所有者または管理者のみ操作できます。"); return;
        }
        boolean on = args[2].equalsIgnoreCase("on");
        zone.setExplosionProtected(on);
        storage.save();
        sender.sendMessage(G + "ゾーン '" + args[1] + "' 爆発保護: " + (on ? G + "ON" : E + "OFF"));
    }

    // ── 販売に出す ────────────────────────────────────────────
    private void cmdSell(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) { sender.sendMessage(E + "プレイヤーのみ使用できます。"); return; }
        if (economy == null) { player.sendMessage(E + "経済プラグイン (Vault) が利用できません。"); return; }
        if (args.length < 3) { player.sendMessage(E + "使い方: /zone sell <名前> <価格>"); return; }
        Zone zone = storage.getZone(args[1]);
        if (zone == null) { player.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }
        if (!zone.isOwnedBy(player.getUniqueId().toString())) { player.sendMessage(E + "自分が所有するゾーンのみ販売できます。"); return; }
        double price;
        try { price = Double.parseDouble(args[2]); } catch (NumberFormatException e) { player.sendMessage(E + "価格は数値で入力してください。"); return; }
        if (price <= 0) { player.sendMessage(E + "価格は1以上で設定してください。"); return; }
        zone.setSellPrice(price);
        storage.save();
        player.sendMessage(GO + "ゾーン '" + zone.getName() + "' を " + economy.format(price) + " で販売リストに登録しました。");
        player.sendMessage(GR + "取り消すには: /zone unsell " + zone.getName());
    }

    // ── 販売取り消し ──────────────────────────────────────────
    private void cmdUnsell(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) { sender.sendMessage(E + "プレイヤーのみ使用できます。"); return; }
        if (args.length < 2) { player.sendMessage(E + "使い方: /zone unsell <名前>"); return; }
        Zone zone = storage.getZone(args[1]);
        if (zone == null) { player.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }
        if (!isAdmin(sender) && !zone.isOwnedBy(player.getUniqueId().toString())) {
            player.sendMessage(E + "所有者または管理者のみ操作できます。"); return;
        }
        if (!zone.isForSale()) { player.sendMessage(W + "このゾーンは販売中ではありません。"); return; }
        zone.setSellPrice(0);
        storage.save();
        player.sendMessage(G + "ゾーン '" + zone.getName() + "' の販売を取り消しました。");
    }

    // ── 購入 ─────────────────────────────────────────────────
    private void cmdBuy(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) { sender.sendMessage(E + "プレイヤーのみ使用できます。"); return; }
        if (economy == null) { player.sendMessage(E + "経済プラグイン (Vault) が利用できません。"); return; }
        if (args.length < 2) { player.sendMessage(E + "使い方: /zone buy <名前> [confirm]"); return; }
        String zoneName = args[1];
        Zone zone = storage.getZone(zoneName);
        if (zone == null) { player.sendMessage(E + "ゾーン '" + zoneName + "' が見つかりません。"); return; }
        if (!zone.isForSale()) { player.sendMessage(E + "このゾーンは販売中ではありません。"); return; }
        if (zone.isOwnedBy(player.getUniqueId().toString())) { player.sendMessage(E + "自分のゾーンは購入できません。"); return; }

        double price = zone.getSellPrice();
        boolean confirmed = args.length >= 3 && args[2].equalsIgnoreCase("confirm");
        if (!confirmed) {
            pendingBuy.put(player.getUniqueId(), new String[]{zoneName, String.valueOf(System.currentTimeMillis() + 30_000)});
            player.sendMessage(GO + "━━ ゾーン購入確認 ━━");
            player.sendMessage(GR + "ゾーン: " + C + zone.getName());
            player.sendMessage(GR + "所有者: " + zone.getOwnerName());
            player.sendMessage(GR + "価格: " + GO + economy.format(price));
            player.sendMessage(GR + "残高: " + economy.format(economy.getBalance(player)));
            player.sendMessage(W + "30秒以内に " + G + "/zone buy " + zoneName + " confirm" + W + " で購入確定。");
            return;
        }
        String[] pending = pendingBuy.get(player.getUniqueId());
        if (pending == null || !pending[0].equals(zoneName) || System.currentTimeMillis() > Long.parseLong(pending[1])) {
            player.sendMessage(E + "確認がタイムアウトしました。もう一度 /zone buy " + zoneName + " を実行してください。");
            pendingBuy.remove(player.getUniqueId()); return;
        }
        pendingBuy.remove(player.getUniqueId());
        if (!economy.has(player, price)) {
            player.sendMessage(E + "残高が不足しています。必要: " + economy.format(price) + " / 所持: " + economy.format(economy.getBalance(player)));
            return;
        }
        String sellerUuid = zone.getOwnerUuid();
        String sellerName = zone.getOwnerName();
        EconomyResponse withdraw = economy.withdrawPlayer(player, price);
        if (!withdraw.transactionSuccess()) { player.sendMessage(E + "決済に失敗しました: " + withdraw.errorMessage); return; }
        if (sellerUuid != null) {
            @SuppressWarnings("deprecation")
            OfflinePlayer seller = Bukkit.getOfflinePlayer(UUID.fromString(sellerUuid));
            economy.depositPlayer(seller, price);
            Player onlineSeller = Bukkit.getPlayer(UUID.fromString(sellerUuid));
            if (onlineSeller != null)
                onlineSeller.sendMessage(GO + "🏠 ゾーン '" + zone.getName() + "' が " + player.getName() + " に " + economy.format(price) + " で売れました！");
        }
        zone.setOwnerUuid(player.getUniqueId().toString());
        zone.setOwnerName(player.getName());
        zone.setSellPrice(0);
        storage.save();
        player.sendMessage(G + "🏠 ゾーン '" + zone.getName() + "' を " + economy.format(price) + " で購入しました！");
        player.sendMessage(GR + "前の所有者: " + sellerName);
    }

    // ── 販売中一覧 ────────────────────────────────────────────
    private void cmdForSale(CommandSender sender, String[] args) {
        List<Zone> forSale = storage.getForSaleZones();
        if (forSale.isEmpty()) { sender.sendMessage(W + "現在販売中のゾーンはありません。"); return; }
        sender.sendMessage(GO + "━━ 販売中のゾーン (" + forSale.size() + "件) ━━");
        for (Zone z : forSale) {
            String price = economy != null ? economy.format(z.getSellPrice()) : String.valueOf(z.getSellPrice());
            sender.sendMessage(C + z.getName() + GR + " | 所有者: " + z.getOwnerName() + " | " + GO + price + GR + " | /zone buy " + z.getName());
        }
    }

    // ── ゾーン情報 ────────────────────────────────────────────
    private void cmdInfo(CommandSender sender, String[] args) {
        Zone zone = null;
        if (args.length >= 2) {
            zone = storage.getZone(args[1]);
            if (zone == null) { sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }
        } else if (sender instanceof Player player) {
            List<Zone> here = storage.getZonesAt(player.getWorld().getName(),
                player.getLocation().getBlockX(), player.getLocation().getBlockY(), player.getLocation().getBlockZ());
            if (here.isEmpty()) { player.sendMessage(W + "現在地にゾーンはありません。"); return; }
            zone = here.get(0);
        } else { sender.sendMessage(E + "使い方: /zone info <名前>"); return; }

        String saleStr = zone.isForSale() && economy != null
            ? G + "販売中 " + GO + economy.format(zone.getSellPrice()) : GR + "非売品";
        sender.sendMessage(C + "━━ ゾーン情報: " + zone.getName() + " ━━");
        sender.sendMessage(GR + "ワールド: " + zone.getWorld());
        sender.sendMessage(GR + "座標1: " + zone.getX1() + ", " + zone.getY1() + ", " + zone.getZ1());
        sender.sendMessage(GR + "座標2: " + zone.getX2() + ", " + zone.getY2() + ", " + zone.getZ2());
        sender.sendMessage(GR + "所有者: " + (zone.isAdminZone() ? GO + "管理者ゾーン" : zone.getOwnerName()));
        sender.sendMessage(GR + "爆発保護: " + (zone.isExplosionProtected() ? G + "ON" : E + "OFF"));
        sender.sendMessage(GR + "販売: " + saleStr);
    }

    // ── 一覧 ──────────────────────────────────────────────────
    private void cmdList(CommandSender sender, String[] args) {
        List<Zone> all = List.copyOf(storage.getAllZones());
        if (all.isEmpty()) { sender.sendMessage(W + "登録されているゾーンはありません。"); return; }
        int page = 1;
        if (args.length >= 2) { try { page = Integer.parseInt(args[1]); } catch (NumberFormatException ignored) {} }
        int perPage = 8, total = (int) Math.ceil(all.size() / (double) perPage);
        page = Math.max(1, Math.min(page, total));
        sender.sendMessage(C + "━━ ゾーン一覧 (" + page + "/" + total + ") ━━");
        all.subList((page - 1) * perPage, Math.min(page * perPage, all.size())).forEach(z -> {
            String owner = z.isAdminZone() ? GO + "[管理]" : GR + z.getOwnerName();
            String exp   = z.isExplosionProtected() ? G + "🛡 " : "   ";
            String sale  = z.isForSale() ? GO + "💰 " : "   ";
            sender.sendMessage(exp + sale + C + z.getName() + GR + " (" + owner + GR + ")");
        });
    }

    // ── 管理者: 所有者変更 ────────────────────────────────────
    private void cmdSetOwner(CommandSender sender, String[] args) {
        if (!isAdmin(sender)) { sender.sendMessage(E + "管理者のみ使用できます。"); return; }
        if (args.length < 3)  { sender.sendMessage(E + "使い方: /zone setowner <名前> <プレイヤー>"); return; }
        Zone zone = storage.getZone(args[1]);
        if (zone == null) { sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }
        @SuppressWarnings("deprecation")
        OfflinePlayer target = Bukkit.getOfflinePlayer(args[2]);
        zone.setOwnerUuid(target.getUniqueId().toString());
        zone.setOwnerName(args[2]);
        zone.setSellPrice(0);
        storage.save();
        sender.sendMessage(G + "ゾーン '" + zone.getName() + "' の所有者を " + args[2] + " に変更しました。");
    }

    // ── 管理者: 管理者ゾーン作成 ─────────────────────────────
    private void cmdAdminZone(CommandSender sender, String[] args) {
        if (!isAdmin(sender)) { sender.sendMessage(E + "管理者のみ使用できます。"); return; }
        if (args.length < 2)  { sender.sendMessage(E + "使い方: /zone adminzone <名前> [x1 y1 z1 x2 y2 z2]"); return; }

        String name = args[1];
        if (storage.getZone(name) != null) { sender.sendMessage(E + "ゾーン名 '" + name + "' はすでに存在します。"); return; }

        int[] c;
        String worldName;
        if (args.length >= 8) {
            c = parseCoords(sender, args, 2);
            if (c == null) return;
            worldName = (sender instanceof Player p) ? p.getWorld().getName() : "world";
        } else if (sender instanceof Player player) {
            Location[] sel = selections.get(player.getUniqueId());
            if (sel == null || sel[0] == null || sel[1] == null) {
                player.sendMessage(E + "座標が選択されていません。ワンドで選択するか座標を直接指定してください。"); return;
            }
            c = new int[]{
                sel[0].getBlockX(), sel[0].getBlockY(), sel[0].getBlockZ(),
                sel[1].getBlockX(), sel[1].getBlockY(), sel[1].getBlockZ()
            };
            worldName = sel[0].getWorld().getName();
            selections.remove(player.getUniqueId());
        } else {
            sender.sendMessage(E + "使い方: /zone adminzone <名前> <x1 y1 z1 x2 y2 z2>"); return;
        }

        storage.addZone(new Zone(name, worldName, c[0], c[1], c[2], c[3], c[4], c[5],
            null, "ADMIN", true, System.currentTimeMillis()));
        sender.sendMessage(G + "管理者ゾーン '" + name + "' を登録しました（爆発保護: ON）。");
    }

    // ── 管理者: ゾーン削除 ────────────────────────────────────
    private void cmdDelete(CommandSender sender, String[] args) {
        if (!isAdmin(sender)) { sender.sendMessage(E + "管理者のみ使用できます。"); return; }
        if (args.length < 2)  { sender.sendMessage(E + "使い方: /zone delete <名前>"); return; }
        if (storage.removeZone(args[1])) sender.sendMessage(G + "ゾーン '" + args[1] + "' を削除しました。");
        else sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。");
    }

    // ── ユーティリティ ────────────────────────────────────────
    private int[] parseCoords(CommandSender sender, String[] args, int offset) {
        try {
            return new int[]{
                Integer.parseInt(args[offset]),     Integer.parseInt(args[offset + 1]),
                Integer.parseInt(args[offset + 2]), Integer.parseInt(args[offset + 3]),
                Integer.parseInt(args[offset + 4]), Integer.parseInt(args[offset + 5])
            };
        } catch (NumberFormatException e) {
            sender.sendMessage(E + "座標は整数で入力してください。"); return null;
        }
    }

    private void sendHelp(CommandSender s) {
        s.sendMessage(C + "━━ ZoneManager ━━");
        s.sendMessage(GO + "/zone wand" + GR + " - 範囲選択ワンドを入手");
        s.sendMessage(W + "/zone claim <名前>" + GR + " - ワンド選択した土地を登録");
        s.sendMessage(W + "/zone claim <名前> <x1 y1 z1 x2 y2 z2>" + GR + " - 座標指定で登録");
        s.sendMessage(W + "/zone unclaim <名前>" + GR + " - 登録解除");
        s.sendMessage(W + "/zone explosion <名前> <on|off>" + GR + " - 爆発保護");
        s.sendMessage(W + "/zone sell <名前> <価格>" + GR + " - 販売に出す");
        s.sendMessage(W + "/zone unsell <名前>" + GR + " - 販売取り消し");
        s.sendMessage(W + "/zone buy <名前> [confirm]" + GR + " - 購入");
        s.sendMessage(W + "/zone forsale" + GR + " - 販売中一覧");
        s.sendMessage(W + "/zone info [名前]" + GR + " - ゾーン情報");
        s.sendMessage(W + "/zone list" + GR + " - 全ゾーン一覧");
        if (isAdmin(s)) {
            s.sendMessage(GO + "/zone adminzone <名前> [x1 y1 z1 x2 y2 z2]" + GR + " - 管理者ゾーン作成");
            s.sendMessage(GO + "/zone setowner <名前> <プレイヤー>" + GR + " - 所有者変更");
            s.sendMessage(GO + "/zone delete <名前>" + GR + " - 強制削除");
        }
    }
}
