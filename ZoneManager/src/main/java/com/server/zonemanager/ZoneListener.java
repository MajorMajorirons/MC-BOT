package com.server.zonemanager;

import org.bukkit.ChatColor;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.block.Block;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataType;

import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class ZoneListener implements Listener {

    private final ZoneStorage storage;
    private final Map<UUID, Location[]> selections;
    private final NamespacedKey wandKey;

    public ZoneListener(ZoneStorage storage, Map<UUID, Location[]> selections, NamespacedKey wandKey) {
        this.storage    = storage;
        this.selections = selections;
        this.wandKey    = wandKey;
    }

    // ── ワンド操作 ──────────────────────────────────────────────
    @EventHandler(priority = EventPriority.HIGH)
    public void onWandUse(PlayerInteractEvent event) {
        ItemStack item = event.getItem();
        if (item == null || !item.hasItemMeta()) return;
        if (!item.getItemMeta().getPersistentDataContainer().has(wandKey, PersistentDataType.BYTE)) return;

        Block block = event.getClickedBlock();
        if (block == null) return;

        Player player = event.getPlayer();
        UUID uid = player.getUniqueId();
        event.setCancelled(true);

        selections.putIfAbsent(uid, new Location[2]);
        Location[] sel = selections.get(uid);

        if (event.getAction() == Action.LEFT_CLICK_BLOCK) {
            sel[0] = block.getLocation();
            player.sendMessage(ChatColor.AQUA + "📍 座標1 を設定: "
                + ChatColor.WHITE + "(" + block.getX() + ", " + block.getY() + ", " + block.getZ() + ")"
                + ChatColor.GRAY + " [" + block.getWorld().getName() + "]");
            if (sel[1] != null) showSelectionSize(player, sel);

        } else if (event.getAction() == Action.RIGHT_CLICK_BLOCK) {
            sel[1] = block.getLocation();
            player.sendMessage(ChatColor.AQUA + "📍 座標2 を設定: "
                + ChatColor.WHITE + "(" + block.getX() + ", " + block.getY() + ", " + block.getZ() + ")"
                + ChatColor.GRAY + " [" + block.getWorld().getName() + "]");
            if (sel[0] != null) showSelectionSize(player, sel);
        }
    }

    private void showSelectionSize(Player player, Location[] sel) {
        int dx = Math.abs(sel[1].getBlockX() - sel[0].getBlockX()) + 1;
        int dy = Math.abs(sel[1].getBlockY() - sel[0].getBlockY()) + 1;
        int dz = Math.abs(sel[1].getBlockZ() - sel[0].getBlockZ()) + 1;
        player.sendMessage(ChatColor.GRAY + "  選択サイズ: " + ChatColor.YELLOW
            + dx + " × " + dy + " × " + dz
            + ChatColor.GRAY + " (" + (dx * dy * dz) + " ブロック) | "
            + ChatColor.GREEN + "/zone claim <名前>" + ChatColor.GRAY + " で登録");
    }

    // ── 爆発保護 ──────────────────────────────────────────────
    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onEntityExplode(EntityExplodeEvent event) {
        filterBlocks(event.blockList());
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onBlockExplode(BlockExplodeEvent event) {
        filterBlocks(event.blockList());
    }

    private void filterBlocks(List<Block> blocks) {
        Iterator<Block> it = blocks.iterator();
        while (it.hasNext()) {
            Block b = it.next();
            List<Zone> zones = storage.getZonesAt(b.getWorld().getName(), b.getX(), b.getY(), b.getZ());
            if (zones.stream().anyMatch(Zone::isExplosionProtected)) it.remove();
        }
    }
}
