package com.dynamicmarket;

import org.bukkit.configuration.file.FileConfiguration;

/**
 * AMM-inspired price engine with exponential impact and mean-reversion decay.
 *
 * Buy formula:  newPrice = currentPrice * exp(+volatility * impact)
 * Sell formula: newPrice = currentPrice * exp(-volatility * impact)
 * where:        impact = 1 - exp(-qty / marketDepth)
 *
 * Transaction cost uses the midpoint impact so large orders get realistic slippage:
 *   avgPrice = currentPrice * exp(±volatility * (1 - exp(-qty / 2*depth)))
 *   totalCost = avgPrice * qty
 *
 * Decay (per-second reversion to base):
 *   newPrice = base + (current - base) * exp(-decayRate * elapsedSeconds)
 */
public class PriceEngine {
    private final DynamicMarket plugin;
    private double marketDepth;
    private double volatility;
    private double decayRate;
    private double minMultiplier;
    private double maxMultiplier;
    private double transactionFee;

    public PriceEngine(DynamicMarket plugin) {
        this.plugin = plugin;
        loadConfig();
    }

    public void loadConfig() {
        FileConfiguration cfg = plugin.getConfig();
        marketDepth    = cfg.getDouble("price-engine.market-depth",         1000);
        volatility     = cfg.getDouble("price-engine.volatility",           0.3);
        decayRate      = cfg.getDouble("price-engine.decay-rate",           0.00005);
        minMultiplier  = cfg.getDouble("price-engine.min-price-multiplier", 0.05);
        maxMultiplier  = cfg.getDouble("price-engine.max-price-multiplier", 20.0);
        transactionFee = cfg.getDouble("price-engine.transaction-fee",      0.02);
    }

    /** Total cost for buying qty items at current price (before fee). */
    private double transactionCost(double current, int qty, boolean isBuy) {
        double halfImpact = 1.0 - Math.exp(-qty / (2.0 * marketDepth));
        double dir = isBuy ? 1.0 : -1.0;
        double avgPrice = current * Math.exp(dir * volatility * halfImpact);
        return avgPrice * qty;
    }

    /** New market price after a trade. */
    public double calcNewPrice(double current, double base, int qty, boolean isBuy) {
        double impact = 1.0 - Math.exp(-qty / marketDepth);
        double dir = isBuy ? 1.0 : -1.0;
        double newPrice = current * Math.exp(dir * volatility * impact);
        return clamp(newPrice, base);
    }

    /** Apply decay toward base over elapsedMs milliseconds. */
    public double applyDecay(double current, double base, long elapsedMs) {
        double seconds = elapsedMs / 1000.0;
        double newPrice = base + (current - base) * Math.exp(-decayRate * seconds);
        return clamp(newPrice, base);
    }

    /** Total cost to buy qty items, including transaction fee. */
    public double getBuyCost(double current, int qty) {
        return transactionCost(current, qty, true) * (1.0 + transactionFee);
    }

    /** Revenue from selling qty items, after transaction fee deducted. */
    public double getSellRevenue(double current, int qty) {
        return transactionCost(current, qty, false) * (1.0 - transactionFee);
    }

    public double getTransactionFee() { return transactionFee; }

    private double clamp(double price, double base) {
        return Math.max(base * minMultiplier, Math.min(base * maxMultiplier, price));
    }
}
