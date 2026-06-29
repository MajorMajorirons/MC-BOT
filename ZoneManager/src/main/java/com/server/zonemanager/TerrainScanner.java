package com.server.zonemanager;

import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.HeightMap;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.plugin.Plugin;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public class TerrainScanner {

    private final Plugin plugin;
    private final String serverUrl;
    private final String apiKey;
    private final HttpClient http;

    public TerrainScanner(Plugin plugin, String serverUrl, String apiKey) {
        this.plugin    = plugin;
        this.serverUrl = serverUrl.replaceAll("/$", "");
        this.apiKey    = apiKey;
        this.http      = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    }

    /** メインスレッドで呼ぶこと（チャンクデータ取得に必要） */
    public void scanAndSend() {
        List<WorldScan> results = new ArrayList<>();

        for (World world : Bukkit.getWorlds()) {
            Chunk[] chunks = world.getLoadedChunks();
            if (chunks.length == 0) continue;

            StringBuilder sb = new StringBuilder();
            sb.append("\"").append(world.getName().replace("\"", "")).append("\":{");
            boolean firstChunk = true;

            for (Chunk chunk : chunks) {
                if (!firstChunk) sb.append(',');
                firstChunk = false;

                int cx = chunk.getX();
                int cz = chunk.getZ();
                sb.append('"').append(cx).append(',').append(cz).append("\":[");

                // 4×4サンプリング（チャンク内で4ブロック間隔）
                for (int i = 0; i < 16; i++) {
                    if (i > 0) sb.append(',');
                    int lx = (i % 4) * 4;
                    int lz = (i / 4) * 4;
                    int wx = cx * 16 + lx;
                    int wz = cz * 16 + lz;

                    int topY   = world.getHighestBlockYAt(wx, wz, HeightMap.WORLD_SURFACE);
                    Material   mat    = world.getBlockAt(wx, topY, wz).getType();
                    Material   below  = topY > world.getMinHeight()
                                        ? world.getBlockAt(wx, topY - 1, wz).getType()
                                        : mat;

                    // 高さによる明暗 (0.6 〜 1.0)
                    float height = Math.max(0f, Math.min(1f, (float)(topY - world.getMinHeight()) / 200f));
                    float bright = 0.60f + 0.40f * height;

                    int rgb = blockColor(mat, below);
                    sb.append(applyBrightness(rgb, bright));
                }
                sb.append(']');
            }
            sb.append('}');
            results.add(new WorldScan(sb.toString()));
        }

        if (results.isEmpty()) return;

        String body = "{" + String.join(",", results.stream().map(w -> w.json).toList()) + "}";

        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(serverUrl + "/api/plugin/terrain"))
                    .header("Content-Type", "application/json")
                    .header("X-Plugin-Key", apiKey)
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .timeout(Duration.ofSeconds(10))
                    .build();
                http.sendAsync(request, HttpResponse.BodyHandlers.discarding());
            } catch (Exception ignored) {}
        });
    }

    private record WorldScan(String json) {}

    // ── ブロック色マッピング ─────────────────────────────────
    private static int blockColor(Material m, Material below) {
        // 水面: 下が水でないなら水色
        if (m == Material.WATER) return 0x3355CC;

        String n = m.name();

        // 植生系（葉・草）: 下のブロック種別で色を変える（バイオーム感を出す）
        if (n.contains("LEAVES") || m == Material.VINE || m == Material.MOSS_CARPET) {
            String b = below.name();
            if (b.contains("SAND")) return 0x5A9B30;    // サバンナ
            if (b.contains("SNOW")) return 0x6EAD45;    // タイガ
            return 0x44A028;
        }
        if (m == Material.GRASS_BLOCK)  return 0x55A830;
        if (m == Material.TALL_GRASS || m == Material.GRASS || m == Material.FERN || m == Material.LARGE_FERN)
            return 0x66BB33;

        // 個別マテリアル
        return switch (m) {
            case DIRT, ROOTED_DIRT      -> 0x8B6340;
            case COARSE_DIRT            -> 0x7A5030;
            case PODZOL                 -> 0x5A3A1A;
            case DIRT_PATH              -> 0xA08040;
            case SAND                   -> 0xDDD090;
            case RED_SAND               -> 0xBE6526;
            case GRAVEL                 -> 0x9A9090;
            case CLAY                   -> 0xA4B0C0;
            case MUD, MUDDY_MANGROVE_ROOTS -> 0x4A3C2A;
            case STONE                  -> 0x888888;
            case COBBLESTONE            -> 0x797979;
            case MOSSY_COBBLESTONE      -> 0x6A8860;
            case DEEPSLATE, COBBLED_DEEPSLATE -> 0x505050;
            case GRANITE                -> 0xA07060;
            case DIORITE                -> 0xBBBBBB;
            case ANDESITE               -> 0x888890;
            case CALCITE                -> 0xCCCCCC;
            case TUFF                   -> 0x727268;
            case DRIPSTONE_BLOCK        -> 0x9A8070;
            case SNOW_BLOCK, POWDER_SNOW -> 0xEEEEFF;
            case SNOW                   -> 0xDDEEFF;
            case ICE                    -> 0x9AB8FC;
            case PACKED_ICE             -> 0x88A8EC;
            case BLUE_ICE               -> 0x6088DC;
            case MYCELIUM               -> 0x7B5E7B;
            case NETHER_BRICKS, CRACKED_NETHER_BRICKS -> 0x2A1014;
            case NETHERRACK             -> 0x7D2422;
            case SOUL_SAND, SOUL_SOIL   -> 0x4D3F28;
            case BASALT, POLISHED_BASALT -> 0x505058;
            case BLACKSTONE             -> 0x2A282E;
            case NETHER_GOLD_ORE        -> 0xAA9000;
            case END_STONE              -> 0xD5CE98;
            case END_STONE_BRICKS       -> 0xC8C188;
            case BEDROCK                -> 0x333333;
            case LAVA                   -> 0xFF6600;
            case OBSIDIAN, CRYING_OBSIDIAN -> 0x1A0B28;
            case MAGMA_BLOCK            -> 0xCC4400;
            case GLOWSTONE              -> 0xEECC66;
            case SEA_LANTERN            -> 0xAADDCC;
            case PRISMARINE             -> 0x4DAAAA;
            case DARK_PRISMARINE        -> 0x2A7070;
            case PRISMARINE_BRICKS      -> 0x5ABBBB;
            case SANDSTONE, SMOOTH_SANDSTONE, CHISELED_SANDSTONE -> 0xD0C060;
            case RED_SANDSTONE          -> 0xC05020;
            case TERRACOTTA             -> 0xAA6644;
            default -> {
                // パターンマッチ
                if (n.contains("LOG") || n.contains("STEM") || n.contains("BAMBOO_BLOCK")) yield 0x7A5530;
                if (n.contains("PLANKS"))                       yield 0xAA8855;
                if (n.contains("MUSHROOM_STEM"))                yield 0xC8B88E;
                if (n.contains("RED_MUSHROOM_BLOCK"))           yield 0xCC2222;
                if (n.contains("BROWN_MUSHROOM_BLOCK"))         yield 0x8B6234;
                if (n.contains("CACTUS"))                       yield 0x4A8C20;
                if (n.contains("BAMBOO"))                       yield 0x6AAA30;
                if (n.contains("SUGAR_CANE"))                   yield 0x88BB55;
                if (n.contains("NETHER_WART"))                  yield 0xAA2233;
                if (n.contains("WARPED") && !n.contains("STEM")) yield 0x167B70;
                if (n.contains("CRIMSON") && !n.contains("STEM")) yield 0x8B0020;
                if (n.contains("WARPED_STEM") || n.contains("WARPED_HYPHAE")) yield 0x2D6B5E;
                if (n.contains("CRIMSON_STEM") || n.contains("CRIMSON_HYPHAE")) yield 0x7A1428;
                if (n.contains("CONCRETE"))                     yield concreteColor(n);
                if (n.contains("TERRACOTTA"))                   yield glazedTerracottaColor(n);
                if (n.contains("WOOL"))                         yield woolColor(n);
                if (n.contains("GLASS") || n.contains("BARRIER")) yield 0x99CCEE;
                if (n.contains("BRICK"))                        yield 0xAA5533;
                if (n.contains("QUARTZ"))                       yield 0xDDDDCC;
                if (n.contains("PURPUR"))                       yield 0xAA77AA;
                if (n.contains("CORAL"))                        yield 0xFF5566;
                if (n.contains("_ORE"))                         yield 0x888888;
                if (n.contains("STAIRS") || n.contains("SLAB") || n.contains("WALL") || n.contains("FENCE")) yield 0x999988;
                yield 0x808080;
            }
        };
    }

    private static int concreteColor(String n) {
        if (n.startsWith("WHITE"))      return 0xE0E0E0;
        if (n.startsWith("ORANGE"))     return 0xE06000;
        if (n.startsWith("MAGENTA"))    return 0xB000B0;
        if (n.startsWith("LIGHT_BLUE")) return 0x6090E0;
        if (n.startsWith("YELLOW"))     return 0xD0C000;
        if (n.startsWith("LIME"))       return 0x60C000;
        if (n.startsWith("PINK"))       return 0xD06080;
        if (n.startsWith("GRAY"))       return 0x606060;
        if (n.startsWith("LIGHT_GRAY")) return 0xA0A0A0;
        if (n.startsWith("CYAN"))       return 0x009090;
        if (n.startsWith("PURPLE"))     return 0x7000A0;
        if (n.startsWith("BLUE"))       return 0x1010A0;
        if (n.startsWith("BROWN"))      return 0x603010;
        if (n.startsWith("GREEN"))      return 0x205000;
        if (n.startsWith("RED"))        return 0x900000;
        if (n.startsWith("BLACK"))      return 0x101010;
        return 0xD0D0D0;
    }

    private static int glazedTerracottaColor(String n) {
        if (n.startsWith("WHITE"))      return 0xD2B2A0;
        if (n.startsWith("ORANGE"))     return 0xC05010;
        if (n.startsWith("YELLOW"))     return 0xC0A030;
        if (n.startsWith("LIME"))       return 0x507030;
        if (n.startsWith("GREEN"))      return 0x304020;
        if (n.startsWith("CYAN"))       return 0x406070;
        if (n.startsWith("BLUE"))       return 0x3040A0;
        if (n.startsWith("LIGHT_BLUE")) return 0x607090;
        if (n.startsWith("PINK"))       return 0xC08080;
        if (n.startsWith("MAGENTA"))    return 0x906080;
        if (n.startsWith("PURPLE"))     return 0x604070;
        if (n.startsWith("RED"))        return 0x804030;
        if (n.startsWith("BROWN"))      return 0x604020;
        if (n.startsWith("GRAY"))       return 0x505050;
        if (n.startsWith("LIGHT_GRAY")) return 0x908880;
        if (n.startsWith("BLACK"))      return 0x252020;
        return 0xA07060;
    }

    private static int woolColor(String n) {
        if (n.startsWith("WHITE"))      return 0xEEEEEE;
        if (n.startsWith("ORANGE"))     return 0xE07020;
        if (n.startsWith("MAGENTA"))    return 0xCC44CC;
        if (n.startsWith("LIGHT_BLUE")) return 0x88AADD;
        if (n.startsWith("YELLOW"))     return 0xEECC00;
        if (n.startsWith("LIME"))       return 0x70DD00;
        if (n.startsWith("PINK"))       return 0xEE88AA;
        if (n.startsWith("GRAY"))       return 0x555555;
        if (n.startsWith("LIGHT_GRAY")) return 0xAAAAAA;
        if (n.startsWith("CYAN"))       return 0x00AAAA;
        if (n.startsWith("PURPLE"))     return 0x8800AA;
        if (n.startsWith("BLUE"))       return 0x2200AA;
        if (n.startsWith("BROWN"))      return 0x774422;
        if (n.startsWith("GREEN"))      return 0x446600;
        if (n.startsWith("RED"))        return 0xAA2222;
        if (n.startsWith("BLACK"))      return 0x222222;
        return 0xEEEEEE;
    }

    private static int applyBrightness(int rgb, float factor) {
        int r = Math.min(255, (int)(((rgb >> 16) & 0xFF) * factor));
        int g = Math.min(255, (int)(((rgb >> 8)  & 0xFF) * factor));
        int b = Math.min(255, (int)((rgb          & 0xFF) * factor));
        return (r << 16) | (g << 8) | b;
    }
}
