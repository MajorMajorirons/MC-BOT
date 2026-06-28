package com.dynamicmarket;

import net.milkbowl.vault.economy.Economy;
import org.bukkit.plugin.RegisteredServiceProvider;
import org.bukkit.plugin.java.JavaPlugin;

public class DynamicMarket extends JavaPlugin {
    private static DynamicMarket instance;
    private Economy economy;
    private MarketDB db;
    private PriceEngine priceEngine;
    private MarketManager marketManager;
    private MarketGUI marketGUI;

    @Override
    public void onEnable() {
        instance = this;
        saveDefaultConfig();

        if (!setupEconomy()) {
            getLogger().severe("Vault/Economy が見つかりません。DynamicMarketを無効化します。");
            getLogger().severe("Vault と EssentialsX がインストールされているか確認してください。");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        db = new MarketDB(this);
        db.initialize();

        priceEngine   = new PriceEngine(this);
        marketManager = new MarketManager(this, db, priceEngine, economy);
        marketGUI     = new MarketGUI(this, marketManager);

        MarketCommand marketCmd = new MarketCommand(this, marketManager, marketGUI);
        getCommand("market").setExecutor(marketCmd);
        getCommand("mkt-discord").setExecutor(marketCmd);
        getCommand("mktadmin").setExecutor(new AdminCommand(this, marketManager, db));

        getServer().getPluginManager().registerEvents(new SignShopListener(this, marketManager), this);
        getServer().getPluginManager().registerEvents(marketGUI, this);

        // Decay prices every 60 seconds asynchronously
        getServer().getScheduler().runTaskTimerAsynchronously(this,
            () -> marketManager.applyPriceDecay(),
            20L * 60, 20L * 60);

        getLogger().info("DynamicMarket v" + getDescription().getVersion() + " 有効化されました。");
    }

    @Override
    public void onDisable() {
        if (db != null) db.close();
        getLogger().info("DynamicMarket 無効化されました。");
    }

    private boolean setupEconomy() {
        if (getServer().getPluginManager().getPlugin("Vault") == null) return false;
        RegisteredServiceProvider<Economy> rsp = getServer().getServicesManager().getRegistration(Economy.class);
        if (rsp == null) return false;
        economy = rsp.getProvider();
        return economy != null;
    }

    public static DynamicMarket getInstance() { return instance; }
    public Economy getEconomy()               { return economy; }
    public MarketDB getDB()                   { return db; }
    public MarketManager getMarketManager()   { return marketManager; }
    public MarketGUI getMarketGUI()           { return marketGUI; }
}
