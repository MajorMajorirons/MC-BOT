package com.server.zonemanager;

public class Zone {
    private final String name;
    private final String world;
    private final int x1, y1, z1, x2, y2, z2;
    private String ownerUuid;   // null = 管理者ゾーン
    private String ownerName;
    private boolean explosionProtected;
    private final long createdAt;

    public Zone(String name, String world,
                int x1, int y1, int z1,
                int x2, int y2, int z2,
                String ownerUuid, String ownerName,
                boolean explosionProtected, long createdAt) {
        this.name   = name;
        this.world  = world;
        this.x1 = Math.min(x1, x2);
        this.y1 = Math.min(y1, y2);
        this.z1 = Math.min(z1, z2);
        this.x2 = Math.max(x1, x2);
        this.y2 = Math.max(y1, y2);
        this.z2 = Math.max(z1, z2);
        this.ownerUuid          = ownerUuid;
        this.ownerName          = ownerName;
        this.explosionProtected = explosionProtected;
        this.createdAt          = createdAt;
    }

    public boolean contains(String world, int x, int y, int z) {
        return this.world.equals(world)
                && x >= x1 && x <= x2
                && y >= y1 && y <= y2
                && z >= z1 && z <= z2;
    }

    public boolean overlaps(Zone o) {
        if (!this.world.equals(o.world)) return false;
        return x1 <= o.x2 && x2 >= o.x1
            && y1 <= o.y2 && y2 >= o.y1
            && z1 <= o.z2 && z2 >= o.z1;
    }

    public boolean isAdminZone()         { return ownerUuid == null; }
    public boolean isOwnedBy(String uuid){ return uuid != null && uuid.equals(ownerUuid); }

    // --- getters ---
    public String  getName()               { return name; }
    public String  getWorld()              { return world; }
    public int     getX1()                 { return x1; }
    public int     getY1()                 { return y1; }
    public int     getZ1()                 { return z1; }
    public int     getX2()                 { return x2; }
    public int     getY2()                 { return y2; }
    public int     getZ2()                 { return z2; }
    public String  getOwnerUuid()          { return ownerUuid; }
    public String  getOwnerName()          { return ownerName; }
    public boolean isExplosionProtected()  { return explosionProtected; }
    public long    getCreatedAt()          { return createdAt; }

    // --- setters ---
    public void setOwnerUuid(String uuid)              { this.ownerUuid = uuid; }
    public void setOwnerName(String name)              { this.ownerName = name; }
    public void setExplosionProtected(boolean enabled) { this.explosionProtected = enabled; }
}
