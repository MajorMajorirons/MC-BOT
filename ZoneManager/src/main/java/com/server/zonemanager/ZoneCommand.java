package com.server.zonemanager;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.*;
import org.bukkit.entity.Player;

import java.util.List;

public class ZoneCommand implements CommandExecutor {

    private static final ChatColor C  = ChatColor.AQUA;
    private static final ChatColor W  = ChatColor.YELLOW;
    private static final ChatColor E  = ChatColor.RED;
    private static final ChatColor G  = ChatColor.GREEN;
    private static final ChatColor GR = ChatColor.GRAY;

    private final ZoneStorage storage;

    public ZoneCommand(ZoneStorage storage) {
        this.storage = storage;
    }

    private boolean isAdmin(CommandSender s) {
        return s.hasPermission("zonemanager.admin");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            sendHelp(sender);
            return true;
        }

        switch (args[0].toLowerCase()) {
            case "claim"      -> cmdClaim(sender, args);
            case "unclaim"    -> cmdUnclaim(sender, args);
            case "explosion"  -> cmdExplosion(sender, args);
            case "info"       -> cmdInfo(sender, args);
            case "list"       -> cmdList(sender, args);
            case "setowner"   -> cmdSetOwner(sender, args);
            case "adminzone"  -> cmdAdminZone(sender, args);
            case "delete"     -> cmdDelete(sender, args);
            default           -> sendHelp(sender);
        }
        return true;
    }

    // /zone claim <name> <x1> <y1> <z1> <x2> <y2> <z2>
    private void cmdClaim(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) { sender.sendMessage(E + "プレイヤーのみ使用できます。"); return; }
        if (!sender.hasPermission("zonemanager.claim")) { player.sendMessage(E + "権限がありません。"); return; }
        if (args.length < 8) { player.sendMessage(E + "使い方: /zone claim <名前> <x1> <y1> <z1> <x2> <y2> <z2>"); return; }

        String name = args[1];
        if (storage.getZone(name) != null) { player.sendMessage(E + "ゾーン名 '" + name + "' はすでに存在します。"); return; }

        int[] coords = parseCoords(player, args, 2);
        if (coords == null) return;

        Zone candidate = new Zone(name, player.getWorld().getName(),
            coords[0], coords[1], coords[2], coords[3], coords[4], coords[5],
            player.getUniqueId().toString(), player.getName(), false, System.currentTimeMillis());

        List<Zone> overlapping = storage.getOverlapping(candidate);
        if (!overlapping.isEmpty()) {
            Zone conflict = overlapping.get(0);
            if (conflict.isAdminZone()) {
                player.sendMessage(E + "指定範囲は管理者ゾーン '" + conflict.getName() + "' と重なっています。");
            } else {
                player.sendMessage(E + "指定範囲は " + conflict.getOwnerName() + " が管理するゾーン '" + conflict.getName() + "' と重なっています。");
            }
            return;
        }

        storage.addZone(candidate);
        player.sendMessage(G + "ゾーン '" + name + "' を登録しました。");
        player.sendMessage(GR + "爆発保護を有効にするには: /zone explosion " + name + " on");
    }

    // /zone unclaim <name>
    private void cmdUnclaim(CommandSender sender, String[] args) {
        if (args.length < 2) { sender.sendMessage(E + "使い方: /zone unclaim <名前>"); return; }
        String name = args[1];
        Zone zone = storage.getZone(name);
        if (zone == null) { sender.sendMessage(E + "ゾーン '" + name + "' が見つかりません。"); return; }

        if (!isAdmin(sender) && !(sender instanceof Player p && zone.isOwnedBy(p.getUniqueId().toString()))) {
            sender.sendMessage(E + "このゾーンの所有者または管理者のみ削除できます。");
            return;
        }

        storage.removeZone(name);
        sender.sendMessage(G + "ゾーン '" + name + "' を削除しました。");
    }

    // /zone explosion <name> <on|off>
    private void cmdExplosion(CommandSender sender, String[] args) {
        if (args.length < 3) { sender.sendMessage(E + "使い方: /zone explosion <名前> <on|off>"); return; }
        String name = args[1];
        Zone zone = storage.getZone(name);
        if (zone == null) { sender.sendMessage(E + "ゾーン '" + name + "' が見つかりません。"); return; }

        if (!isAdmin(sender) && !(sender instanceof Player p && zone.isOwnedBy(p.getUniqueId().toString()))) {
            sender.sendMessage(E + "このゾーンの所有者または管理者のみ変更できます。");
            return;
        }

        boolean enabled = args[2].equalsIgnoreCase("on");
        zone.setExplosionProtected(enabled);
        storage.save();
        sender.sendMessage(G + "ゾーン '" + name + "' の爆発保護を " +
            (enabled ? ChatColor.GREEN + "ON" : ChatColor.RED + "OFF") + G + " にしました。");
    }

    // /zone info [name]
    private void cmdInfo(CommandSender sender, String[] args) {
        Zone zone = null;
        if (args.length >= 2) {
            zone = storage.getZone(args[1]);
            if (zone == null) { sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }
        } else if (sender instanceof Player player) {
            List<Zone> here = storage.getZonesAt(
                player.getWorld().getName(),
                player.getLocation().getBlockX(),
                player.getLocation().getBlockY(),
                player.getLocation().getBlockZ()
            );
            if (here.isEmpty()) { player.sendMessage(W + "現在地にゾーンはありません。"); return; }
            zone = here.get(0);
        } else {
            sender.sendMessage(E + "使い方: /zone info <名前>");
            return;
        }

        sender.sendMessage(C + "━━ ゾーン情報: " + zone.getName() + " ━━");
        sender.sendMessage(GR + "ワールド: " + zone.getWorld());
        sender.sendMessage(GR + "座標1: " + zone.getX1() + ", " + zone.getY1() + ", " + zone.getZ1());
        sender.sendMessage(GR + "座標2: " + zone.getX2() + ", " + zone.getY2() + ", " + zone.getZ2());
        sender.sendMessage(GR + "所有者: " + (zone.isAdminZone() ? "管理者ゾーン" : zone.getOwnerName()));
        sender.sendMessage(GR + "爆発保護: " + (zone.isExplosionProtected() ? G + "ON" : E + "OFF"));
    }

    // /zone list [page]
    private void cmdList(CommandSender sender, String[] args) {
        List<Zone> all = List.copyOf(storage.getAllZones());
        if (all.isEmpty()) { sender.sendMessage(W + "登録されているゾーンはありません。"); return; }

        int page = 1;
        if (args.length >= 2) { try { page = Integer.parseInt(args[1]); } catch (NumberFormatException ignored) {} }
        int perPage = 8;
        int total = (int) Math.ceil(all.size() / (double) perPage);
        page = Math.max(1, Math.min(page, total));

        sender.sendMessage(C + "━━ ゾーン一覧 (" + page + "/" + total + ") ━━");
        all.subList((page - 1) * perPage, Math.min(page * perPage, all.size())).forEach(z -> {
            String owner = z.isAdminZone() ? ChatColor.GOLD + "[管理]" : GR + z.getOwnerName();
            String exp   = z.isExplosionProtected() ? G + "🛡" : GR + "　";
            sender.sendMessage(exp + " " + C + z.getName() + GR + " (" + owner + GR + ")");
        });
    }

    // /zone setowner <name> <player>  (admin only)
    private void cmdSetOwner(CommandSender sender, String[] args) {
        if (!isAdmin(sender)) { sender.sendMessage(E + "管理者のみ使用できます。"); return; }
        if (args.length < 3)  { sender.sendMessage(E + "使い方: /zone setowner <名前> <プレイヤー>"); return; }

        Zone zone = storage.getZone(args[1]);
        if (zone == null) { sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。"); return; }

        @SuppressWarnings("deprecation")
        org.bukkit.OfflinePlayer target = Bukkit.getOfflinePlayer(args[2]);
        zone.setOwnerUuid(target.getUniqueId().toString());
        zone.setOwnerName(args[2]);
        storage.save();
        sender.sendMessage(G + "ゾーン '" + zone.getName() + "' の所有者を " + args[2] + " に変更しました。");
    }

    // /zone adminzone <name> <x1> <y1> <z1> <x2> <y2> <z2>  (admin only)
    private void cmdAdminZone(CommandSender sender, String[] args) {
        if (!isAdmin(sender)) { sender.sendMessage(E + "管理者のみ使用できます。"); return; }
        if (args.length < 8)  { sender.sendMessage(E + "使い方: /zone adminzone <名前> <x1> <y1> <z1> <x2> <y2> <z2>"); return; }

        String name = args[1];
        if (storage.getZone(name) != null) { sender.sendMessage(E + "ゾーン名 '" + name + "' はすでに存在します。"); return; }

        int[] coords = parseCoords(sender, args, 2);
        if (coords == null) return;

        String world = (sender instanceof Player p) ? p.getWorld().getName() : "world";
        Zone zone = new Zone(name, world,
            coords[0], coords[1], coords[2], coords[3], coords[4], coords[5],
            null, "ADMIN", true, System.currentTimeMillis());

        storage.addZone(zone);
        sender.sendMessage(G + "管理者ゾーン '" + name + "' を登録しました（爆発保護: ON）。");
    }

    // /zone delete <name>  (admin only)
    private void cmdDelete(CommandSender sender, String[] args) {
        if (!isAdmin(sender)) { sender.sendMessage(E + "管理者のみ使用できます。"); return; }
        if (args.length < 2)  { sender.sendMessage(E + "使い方: /zone delete <名前>"); return; }

        if (storage.removeZone(args[1])) {
            sender.sendMessage(G + "ゾーン '" + args[1] + "' を削除しました。");
        } else {
            sender.sendMessage(E + "ゾーン '" + args[1] + "' が見つかりません。");
        }
    }

    private int[] parseCoords(CommandSender sender, String[] args, int offset) {
        try {
            return new int[]{
                Integer.parseInt(args[offset]),
                Integer.parseInt(args[offset + 1]),
                Integer.parseInt(args[offset + 2]),
                Integer.parseInt(args[offset + 3]),
                Integer.parseInt(args[offset + 4]),
                Integer.parseInt(args[offset + 5]),
            };
        } catch (NumberFormatException e) {
            sender.sendMessage(E + "座標は整数で指定してください。");
            return null;
        }
    }

    private void sendHelp(CommandSender s) {
        s.sendMessage(C + "━━ ZoneManager コマンド ━━");
        s.sendMessage(W + "/zone claim <名前> <x1> <y1> <z1> <x2> <y2> <z2>" + GR + " - 土地を登録");
        s.sendMessage(W + "/zone unclaim <名前>" + GR + " - 登録を解除");
        s.sendMessage(W + "/zone explosion <名前> <on|off>" + GR + " - 爆発保護の設定");
        s.sendMessage(W + "/zone info [名前]" + GR + " - ゾーン情報（省略で現在地）");
        s.sendMessage(W + "/zone list" + GR + " - ゾーン一覧");
        if (isAdmin(s)) {
            s.sendMessage(ChatColor.GOLD + "/zone adminzone <名前> <x1> <y1> <z1> <x2> <y2> <z2>" + GR + " - 管理者ゾーン作成");
            s.sendMessage(ChatColor.GOLD + "/zone setowner <名前> <プレイヤー>" + GR + " - 所有者変更");
            s.sendMessage(ChatColor.GOLD + "/zone delete <名前>" + GR + " - ゾーン削除");
        }
    }
}
