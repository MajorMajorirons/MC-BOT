package com.dynamicmarket;

public class MarketItem {
    private final String itemKey;
    private final String displayName;
    private final double basePrice;
    private double currentPrice;
    private int totalBought;
    private int totalSold;
    private long lastUpdated;
    private boolean enabled;

    public MarketItem(String itemKey, String displayName, double basePrice, double currentPrice,
                      int totalBought, int totalSold, long lastUpdated, boolean enabled) {
        this.itemKey = itemKey;
        this.displayName = displayName;
        this.basePrice = basePrice;
        this.currentPrice = currentPrice;
        this.totalBought = totalBought;
        this.totalSold = totalSold;
        this.lastUpdated = lastUpdated;
        this.enabled = enabled;
    }

    public String getItemKey()      { return itemKey; }
    public String getDisplayName()  { return displayName; }
    public double getBasePrice()    { return basePrice; }
    public double getCurrentPrice() { return currentPrice; }
    public int getTotalBought()     { return totalBought; }
    public int getTotalSold()       { return totalSold; }
    public long getLastUpdated()    { return lastUpdated; }
    public boolean isEnabled()      { return enabled; }

    public void setCurrentPrice(double price) { this.currentPrice = price; }
    public void setLastUpdated(long ts)       { this.lastUpdated = ts; }

    /** §c▲ / §a▼ / §7─ */
    public String getPriceTrend() {
        if (currentPrice > basePrice * 1.02) return "§c▲";
        if (currentPrice < basePrice * 0.98) return "§a▼";
        return "§7─";
    }

    public double getPriceChangePercent() {
        return (currentPrice - basePrice) / basePrice * 100.0;
    }
}
