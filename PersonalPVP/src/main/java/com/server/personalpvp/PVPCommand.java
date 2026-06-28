package com.server.personalpvp;

import org.bukkit.ChatColor;
import org.bukkit.command.*;
import org.bukkit.entity.Player;

public class PVPCommand implements CommandExecutor {

    private final PersonalPVP plugin;

    public PVPCommand(PersonalPVP plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("このコマンドはプレイヤーのみ使用できます。");
            return true;
        }

        boolean current = plugin.isPvpEnabled(player.getUniqueId());

        if (args.length == 0) {
            // トグル
            setAndNotify(player, !current);
        } else {
            switch (args[0].toLowerCase()) {
                case "on"  -> setAndNotify(player, true);
                case "off" -> setAndNotify(player, false);
                default    -> player.sendMessage(ChatColor.RED + "使い方: /pvp [on|off]");
            }
        }
        return true;
    }

    private void setAndNotify(Player player, boolean enabled) {
        boolean current = plugin.isPvpEnabled(player.getUniqueId());
        if (current == enabled) {
            player.sendMessage(ChatColor.GRAY + "PVP はすでに " +
                    (enabled ? ChatColor.RED + "ON" : ChatColor.AQUA + "OFF") +
                    ChatColor.GRAY + " です。");
            return;
        }
        plugin.setPvpEnabled(player.getUniqueId(), enabled);
        if (enabled) {
            player.sendMessage(ChatColor.RED + "⚔ PVP を ON にしました。" +
                    ChatColor.GRAY + " 他のプレイヤーと戦闘できます。");
        } else {
            player.sendMessage(ChatColor.AQUA + "🛡 PVP を OFF にしました。" +
                    ChatColor.GRAY + " ダメージを受けず、与えることもできません。");
        }
    }
}
