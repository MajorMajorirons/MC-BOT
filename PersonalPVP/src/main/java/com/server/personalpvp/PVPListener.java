package com.server.personalpvp;

import org.bukkit.ChatColor;
import org.bukkit.entity.*;
import org.bukkit.event.*;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.projectiles.ProjectileSource;

public class PVPListener implements Listener {

    private final PersonalPVP plugin;

    public PVPListener(PersonalPVP plugin) {
        this.plugin = plugin;
    }

    @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
    public void onEntityDamage(EntityDamageByEntityEvent event) {
        if (!(event.getEntity() instanceof Player victim)) return;

        Player attacker = resolveAttacker(event.getDamager());
        if (attacker == null || attacker.equals(victim)) return;

        boolean attackerPvp = plugin.isPvpEnabled(attacker.getUniqueId());
        boolean victimPvp   = plugin.isPvpEnabled(victim.getUniqueId());

        // 両方ONのときのみダメージ成立
        if (attackerPvp && victimPvp) return;

        event.setCancelled(true);

        if (!attackerPvp) {
            attacker.sendMessage(ChatColor.RED + "⚔ PVP がオフのため攻撃できません。 " +
                    ChatColor.GRAY + "(/pvp on で有効化)");
        } else {
            // 攻撃者はONだが被害者がOFF
            attacker.sendMessage(ChatColor.YELLOW + "⚔ " + victim.getName() +
                    " は PVP をオフにしています。");
        }
    }

    private Player resolveAttacker(Entity damager) {
        if (damager instanceof Player p) return p;

        // 矢・トライデント・釣り竿など飛び道具
        if (damager instanceof Projectile proj) {
            ProjectileSource source = proj.getShooter();
            if (source instanceof Player p) return p;
        }

        // Wind Charge (1.21+) など他のエンティティはプレイヤー起源でないので null
        return null;
    }
}
