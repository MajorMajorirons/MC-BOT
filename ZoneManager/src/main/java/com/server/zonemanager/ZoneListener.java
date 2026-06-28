package com.server.zonemanager;

import org.bukkit.block.Block;
import org.bukkit.event.*;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.block.BlockExplodeEvent;

import java.util.Iterator;
import java.util.List;

public class ZoneListener implements Listener {

    private final ZoneStorage storage;

    public ZoneListener(ZoneStorage storage) {
        this.storage = storage;
    }

    /** エンティティ爆発（TNT・クリーパー・ベッド・アンカーなど） */
    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onEntityExplode(EntityExplodeEvent event) {
        filterBlocks(event.blockList());
    }

    /** ブロック爆発（Respawn Anchorなど） */
    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onBlockExplode(BlockExplodeEvent event) {
        filterBlocks(event.blockList());
    }

    private void filterBlocks(List<Block> blocks) {
        Iterator<Block> it = blocks.iterator();
        while (it.hasNext()) {
            Block b = it.next();
            List<Zone> zones = storage.getZonesAt(
                b.getWorld().getName(), b.getX(), b.getY(), b.getZ()
            );
            boolean protected_ = zones.stream().anyMatch(Zone::isExplosionProtected);
            if (protected_) it.remove();
        }
    }
}
