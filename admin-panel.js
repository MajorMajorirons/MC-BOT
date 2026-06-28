'use strict';
const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const crypto = require('crypto');

const axios = require('axios');

let wsClients          = new Set();
let _getProcess        = () => null;
let _dbPath            = '';
let _schedulePath      = '';
let _reloadSchedule    = () => {};
let _onStart           = () => {};
let _onStop            = () => {};
let _onRestart         = () => {};
let _getOnlinePlayers  = () => [];
let _getDiscordClient  = () => null;
let _clientId          = '';
let _clientSecret      = '';
let _panelUrl          = '';
let _adminRoleId       = '';

// DB（セッション・モデレーションログ）
let _adminDb = null;

function initAdminDB() {
    try {
        _adminDb = new Database(path.join(_serverPath, 'admin-panel.db'));
        _adminDb.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                username TEXT,
                avatar TEXT,
                authorized_guilds TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mod_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                target TEXT NOT NULL,
                reason TEXT,
                duration TEXT,
                admin_discord_id TEXT,
                admin_username TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mod_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS punishment_counts (
                target TEXT PRIMARY KEY,
                kick_count INTEGER NOT NULL DEFAULT 0,
                tempban_count INTEGER NOT NULL DEFAULT 0
            );
        `);
        _adminDb.prepare("INSERT OR IGNORE INTO mod_settings VALUES ('kick_to_tempban','0')").run();
        _adminDb.prepare("INSERT OR IGNORE INTO mod_settings VALUES ('tempban_to_ban','0')").run();
        _adminDb.prepare("INSERT OR IGNORE INTO mod_settings VALUES ('auto_tempban_duration','1d')").run();
        // 期限切れセッションを削除
        _adminDb.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - 86400_000);
    } catch (e) {
        console.error('[ADMIN DB] initAdminDB エラー:', e.message);
        _adminDb = null;
    }
}

function createSession(data) {
    const token = crypto.randomBytes(32).toString('hex');
    _adminDb.prepare(
        'INSERT INTO sessions (token, user_id, username, avatar, authorized_guilds, created_at) VALUES (?,?,?,?,?,?)'
    ).run(token, data.userId, data.username || null, data.avatar || null, JSON.stringify(data.authorizedGuilds || []), Date.now());
    return token;
}
function getSession(req) {
    try {
        const token = parseCookie(req)['session'];
        if (!token) return null;
        if (!_adminDb) return null;
        const row = _adminDb.prepare('SELECT * FROM sessions WHERE token=?').get(token);
        if (!row) return null;
        if (Date.now() - row.created_at > 86400_000) {
            _adminDb.prepare('DELETE FROM sessions WHERE token=?').run(token);
            return null;
        }
        return { userId: row.user_id, username: row.username, avatar: row.avatar, authorizedGuilds: JSON.parse(row.authorized_guilds || '[]') };
    } catch (e) {
        console.error('[SESSION] getSession エラー:', e.message);
        return null;
    }
}

const MOD_LEVELS = { kick: 1, tempban: 2, ban: 3, tempunban: 0, unban: 0 };

function logMod(action, target, { reason, duration, req } = {}) {
    const newLevel = MOD_LEVELS[action] ?? 1;
    const existing = _adminDb.prepare('SELECT action FROM mod_log WHERE target = ?').get(target);
    if (existing) {
        const existingLevel = MOD_LEVELS[existing.action] ?? 1;
        // 解除系は履歴から削除して終了
        if (newLevel === 0) {
            _adminDb.prepare('DELETE FROM mod_log WHERE target = ?').run(target);
            return;
        }
        // 処罰は同レベル以上のみ上書き
        if (newLevel < existingLevel) return;
    } else if (newLevel === 0) {
        return; // 解除対象がそもそも履歴にない
    }
    _adminDb.prepare('DELETE FROM mod_log WHERE target = ?').run(target);
    _adminDb.prepare(
        'INSERT INTO mod_log (action, target, reason, duration, admin_discord_id, admin_username, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(action, target, reason || null, duration || null, req?.session?.userId || null, req?.session?.username || null, Date.now());
}

function getSetting(key, def = '') {
    if (!_adminDb) return def;
    const r = _adminDb.prepare('SELECT value FROM mod_settings WHERE key=?').get(key);
    return r ? r.value : def;
}

function resetPunishmentCounts(target) {
    _adminDb.prepare('DELETE FROM punishment_counts WHERE target=?').run(target);
}

function incrementAndEscalate(target, action, proc) {
    if (!_adminDb) return;
    if (action !== 'kick' && action !== 'tempban') return;

    const field = action === 'kick' ? 'kick_count' : 'tempban_count';
    _adminDb.prepare(`
        INSERT INTO punishment_counts (target, ${field}) VALUES (?,1)
        ON CONFLICT(target) DO UPDATE SET ${field}=${field}+1
    `).run(target);

    const counts = _adminDb.prepare('SELECT * FROM punishment_counts WHERE target=?').get(target);

    if (action === 'kick') {
        const threshold = parseInt(getSetting('kick_to_tempban', '0'), 10);
        if (threshold > 0 && counts.kick_count >= threshold) {
            const duration = getSetting('auto_tempban_duration', '1d');
            _adminDb.prepare('UPDATE punishment_counts SET kick_count=0 WHERE target=?').run(target);
            const reason = `追放が${threshold}回に達したため自動参加停止`;
            if (proc) {
                if (_getOnlinePlayers().has(target)) proc.stdin.write(`kick ${target} ${reason}\n`);
                proc.stdin.write(`tempban ${target} ${duration} ${reason}\n`);
            } else {
                const ms = _parseDurationMs(duration);
                if (ms) _writeBannedPlayers(target, reason, new Date(Date.now() + ms));
            }
            logMod('tempban', target, { reason, duration });
            incrementAndEscalate(target, 'tempban', proc);
        }
    } else {
        const threshold = parseInt(getSetting('tempban_to_ban', '0'), 10);
        if (threshold > 0 && counts.tempban_count >= threshold) {
            _adminDb.prepare('UPDATE punishment_counts SET tempban_count=0 WHERE target=?').run(target);
            const reason = `参加停止が${threshold}回に達したため自動BAN`;
            if (proc) {
                proc.stdin.write(`ban ${target} ${reason}\n`);
            } else {
                _writeBannedPlayers(target, reason, null);
            }
            logMod('ban', target, { reason });
        }
    }
}

function _banDateStr(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000');
}

function _parseDurationMs(duration) {
    const m = duration.match(/^(\d+)(m|h|d|w|mo|y)$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const units = { m: 60000, h: 3600000, d: 86400000, w: 604800000, mo: 2592000000, y: 31536000000 };
    return n * units[m[2]];
}

function _writeBannedPlayers(player, reason, expiresDate) {
    const usercachePath = path.join(_serverPath, 'usercache.json');
    const bannedPath    = path.join(_serverPath, 'banned-players.json');
    let uuid = null, name = player;
    try {
        const cache = JSON.parse(fs.readFileSync(usercachePath, 'utf8'));
        const hit = cache.find(e => e.name.toLowerCase() === player.toLowerCase());
        if (hit) { uuid = hit.uuid; name = hit.name; }
    } catch {}
    if (!uuid) uuid = player.toLowerCase();
    let banned = [];
    try { banned = JSON.parse(fs.readFileSync(bannedPath, 'utf8')); } catch {}
    banned = banned.filter(e => e.name.toLowerCase() !== player.toLowerCase());
    banned.push({
        uuid, name,
        created: _banDateStr(new Date()),
        source: 'Admin Panel',
        expires: expiresDate ? _banDateStr(expiresDate) : 'forever',
        reason: reason || 'Banned by an operator.'
    });
    fs.writeFileSync(bannedPath, JSON.stringify(banned, null, 2), 'utf8');
}

function parseCookie(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(c => {
        const i = c.indexOf('=');
        if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
    });
    return out;
}

// 戻り値: 'owner' | 'admin' | 'denied' | 'not_member'
async function checkAccess(userId, guildId) {
    const client = _getDiscordClient();
    if (!client) return 'denied';
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return 'denied';
    if (guild.ownerId === userId) return 'owner';
    try {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000));
        const member = await Promise.race([guild.members.fetch(userId), timeout]);
        if (!member) return 'not_member';
        if (_adminRoleId && member.roles.cache.has(_adminRoleId)) return 'admin';
        return 'denied';
    } catch { return 'not_member'; }
}

function readScheduleConfig() {
    try { return JSON.parse(fs.readFileSync(_schedulePath, 'utf-8')); }
    catch { return { schedules: [] }; }
}
function writeScheduleConfig(cfg) {
    fs.writeFileSync(_schedulePath, JSON.stringify(cfg, null, 2), 'utf-8');
}

// start-server.js から呼ばれる
let _serverPath = '';

// プレイヤー位置キャッシュ（ZoneManager プラグインから POST される）
let _playerPositions = {};
const PLUGIN_API_KEY = process.env.PLUGIN_API_KEY || 'changeme';

function readZones() {
    try {
        const zonesPath = path.join(_serverPath, 'plugins', 'ZoneManager', 'zones.yml');
        if (!fs.existsSync(zonesPath)) return {};
        const text = fs.readFileSync(zonesPath, 'utf8');
        const zones = {};
        let inZones = false, current = null;
        for (const line of text.split(/\r?\n/)) {
            if (line === 'zones:') { inZones = true; continue; }
            if (!inZones) continue;
            const nm = line.match(/^  (\S+):$/);
            if (nm) { current = nm[1]; zones[current] = { name: current }; continue; }
            if (current) {
                const kv = line.match(/^    ([^:\s]+): ?(.*)$/);
                if (kv) {
                    let v = kv[2];
                    if (v === 'true') v = true;
                    else if (v === 'false') v = false;
                    else if (v === 'null' || v === '') v = null;
                    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
                    zones[current][kv[1]] = v;
                }
            }
        }
        return zones;
    } catch { return {}; }
}

function startAdminPanel({ port, serverPath, getProcess, dbPath, schedulePath, reloadSchedule, getOnlinePlayers,
                           getDiscordClient, clientId, clientSecret, panelUrl, adminRoleId,
                           onStart, onStop, onRestart }) {
    _getProcess        = getProcess;
    _serverPath        = serverPath || '';
    _dbPath            = dbPath;
    initAdminDB();
    _schedulePath      = schedulePath      || '';
    _reloadSchedule    = reloadSchedule    || (() => {});
    _getOnlinePlayers  = getOnlinePlayers  || (() => []);
    _getDiscordClient  = getDiscordClient  || (() => null);
    _clientId          = clientId          || '';
    _clientSecret      = clientSecret      || '';
    _panelUrl          = panelUrl          || 'http://localhost:4000';
    _adminRoleId       = adminRoleId       || '';
    _onStart           = onStart    || (() => {});
    _onStop            = onStop     || (() => {});
    _onRestart         = onRestart  || (() => {});

    const REDIRECT_URI = `${_panelUrl}/auth/callback`;
    const OAUTH_URL = `https://discord.com/api/oauth2/authorize?client_id=${_clientId}`
        + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;

    const app = express();
    app.use(express.json());

    // 死活確認（認証不要）
    app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

    // 認証不要ルート
    app.get('/auth/discord', (req, res) => res.redirect(OAUTH_URL));

    app.get('/auth/logout', (req, res) => {
        const token = parseCookie(req)['session'];
        if (token) sessions.delete(token);
        res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
        res.redirect('/');
    });

    app.get('/auth/callback', async (req, res) => {
        const { code } = req.query;
        if (!code) return res.redirect('/');
        // 全体に15秒タイムアウト
        const timer = setTimeout(() => {
            if (!res.headersSent) res.status(504).send('認証がタイムアウトしました。<a href="/auth/discord">再試行</a>');
        }, 15000);
        try {
            // コードをトークンに交換
            const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
                new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  auth: { username: _clientId, password: _clientSecret } }
            );
            const accessToken = tokenRes.data.access_token;

            // ユーザー情報取得
            const userRes = await axios.get('https://discord.com/api/users/@me',
                { headers: { Authorization: `Bearer ${accessToken}` } });
            const user = userRes.data;

            // ユーザーのギルド一覧取得
            const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds',
                { headers: { Authorization: `Bearer ${accessToken}` } });
            const userGuildIds = new Set(guildsRes.data.map(g => g.id));

            // Botが入っているギルドとユーザーが共有しているものを確認
            const client = _getDiscordClient();
            const sharedGuilds = client
                ? [...client.guilds.cache.keys()].filter(id => userGuildIds.has(id))
                : [];

            // 共有サーバーが一つもない
            if (sharedGuilds.length === 0) {
                return res.send(buildErrorHTML(
                    user, '共有サーバーが見つかりません',
                    'このBotと共通のDiscordサーバーにどこにも参加していません。<br>Botが入っているサーバーに参加してから再度お試しください。'
                ));
            }

            // 各サーバーのアクセス権をチェック
            const authorized = [];
            const deniedGuilds = [];
            for (const gId of sharedGuilds) {
                const result = await checkAccess(user.id, gId);
                if (result === 'owner' || result === 'admin') {
                    authorized.push(gId);
                } else if (result === 'denied') {
                    deniedGuilds.push(gId);
                }
            }

            // 共有サーバーはあるが権限がない
            if (authorized.length === 0) {
                const guildNames = deniedGuilds
                    .map(id => client.guilds.cache.get(id)?.name || id)
                    .join('、');
                return res.send(buildErrorHTML(
                    user, 'アクセスできません',
                    `参加しているサーバー（${guildNames}）で管理者ロールが付与されていません。<br>サーバーオーナーに連絡してロールを付与してもらってください。`
                ));
            }

            const token = createSession({ userId: user.id, username: user.username,
                avatar: user.avatar, authorizedGuilds: authorized });
            res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; Max-Age=86400`);
            res.redirect('/');
        } catch (e) {
            console.error('[ADMIN] OAuth2エラー:', e.message);
            if (!res.headersSent) res.status(500).send('認証エラーが発生しました。<a href="/auth/discord">再試行</a>');
        } finally {
            clearTimeout(timer);
        }
    });

    // ---- 公開ルート（認証不要）----

    // ゾーン一覧（zones.yml を直接読む）
    app.get('/public/zones', (req, res) => res.json(readZones()));

    // プレイヤー位置（30秒以上更新なしは除外）
    app.get('/public/players', (req, res) => {
        const now = Date.now();
        const active = Object.fromEntries(
            Object.entries(_playerPositions).filter(([, p]) => now - p.updated < 30000)
        );
        res.json(active);
    });

    // プラグインからの位置更新（APIキー認証）
    app.post('/api/plugin/update', (req, res) => {
        if (req.headers['x-plugin-key'] !== PLUGIN_API_KEY)
            return res.status(401).json({ error: 'Unauthorized' });
        const { players } = req.body || {};
        if (players && typeof players === 'object') {
            const now = Date.now();
            _playerPositions = Object.fromEntries(
                Object.entries(players).map(([name, p]) => [name, { ...p, updated: now }])
            );
        }
        res.json({ ok: true });
    });

    // マップページ（ゾーン + プレイヤー位置を表示）
    app.get('/map', (req, res) => {
        const mapFile = path.join(__dirname, 'public', 'map.html');
        if (fs.existsSync(mapFile)) return res.sendFile(mapFile);
        res.status(404).send('map.html が見つかりません。');
    });

    // 認証ミドルウェア（/auth/* 以外に適用）
    const skipAuth = process.env.ADMIN_SKIP_AUTH === 'true';
    const requireAuth = (req, res, next) => {
        if (req.path.startsWith('/auth/') || req.path === '/ping' ||
            req.path.startsWith('/public/') || req.path === '/map' ||
            req.path === '/api/plugin/update') return next();
        if (skipAuth) {
            req.session = { userId: 'bypass', username: '管理者(bypass)', avatar: null, authorizedGuilds: [] };
            return next();
        }
        const session = getSession(req);
        if (!session) {
            if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
                return res.status(401).json({ error: '認証が必要です', redirect: '/auth/discord' });
            }
            return res.redirect('/auth/discord');
        }
        req.session = session;
        next();
    };
    app.use(requireAuth);

    // ---- API ----

    // 過去に参加したことがあるプレイヤー一覧（usercache.json から）
    app.get('/api/players/known', (req, res) => {
        try {
            const cachePath = path.join(_serverPath, 'usercache.json');
            if (!fs.existsSync(cachePath)) return res.json([]);
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            res.json(cache.map(e => e.name).filter(Boolean).sort());
        } catch { res.json([]); }
    });

    app.get('/api/me', (req, res) => {
        const userId = req.session?.userId;
        if (!userId || !_dbPath || !fs.existsSync(_dbPath)) return res.json({ mcName: null });
        try {
            const db = new Database(_dbPath, { readonly: true });
            const row = db.prepare("SELECT mc_name FROM discord_links WHERE discord_id=?").get(userId);
            db.close();
            res.json({ mcName: row?.mc_name || null });
        } catch { res.json({ mcName: null }); }
    });

    app.get('/api/status', (req, res) => {
        const players = _getOnlinePlayers();
        res.json({ online: _getProcess() !== null, playerCount: players.length, players });
    });

    app.post('/api/start', (req, res) => {
        if (_getProcess()) return res.status(400).json({ error: '既に起動中です' });
        _onStart();
        res.json({ ok: true });
    });

    app.post('/api/stop', (req, res) => {
        if (!_getProcess()) return res.status(400).json({ error: '既に停止中です' });
        _onStop();
        res.json({ ok: true });
    });

    app.post('/api/restart', (req, res) => {
        _onRestart();
        res.json({ ok: true });
    });

    app.post('/api/command', (req, res) => {
        const proc = _getProcess();
        if (!proc) return res.status(400).json({ error: 'サーバーが停止中です' });
        const cmd = (req.body.command || '').replace(/^\//, '').trim();
        if (!cmd) return res.status(400).json({ error: 'コマンドが空です' });
        proc.stdin.write(cmd + '\n');
        res.json({ ok: true });
    });

    app.get('/api/market/listings', (req, res) => {
        if (!fs.existsSync(_dbPath)) return res.json([]);
        const db = new Database(_dbPath, { readonly: true });
        try {
            const rows = db.prepare(
                "SELECT id,seller_name,item_type,remaining_amount,price_per_unit,listed_at,status FROM listings WHERE status='ACTIVE' ORDER BY listed_at DESC LIMIT 100"
            ).all();
            res.json(rows);
        } finally { db.close(); }
    });

    app.post('/api/market/cancel/:id', (req, res) => {
        if (!fs.existsSync(_dbPath)) return res.status(404).json({ error: 'DB not found' });
        const db = new Database(_dbPath);
        try {
            const r = db.prepare("UPDATE listings SET status='CANCELLED' WHERE id=? AND status='ACTIVE'").run(req.params.id);
            res.json({ ok: r.changes > 0 });
        } finally { db.close(); }
    });

    app.get('/api/market/transactions', (req, res) => {
        if (!fs.existsSync(_dbPath)) return res.json([]);
        const db = new Database(_dbPath, { readonly: true });
        try {
            const rows = db.prepare(
                'SELECT t.id,t.buyer_name,t.item_type,t.amount,t.price_per_unit,t.total_price,t.sold_at,l.seller_name ' +
                'FROM transactions t LEFT JOIN listings l ON t.listing_id=l.id ORDER BY t.sold_at DESC LIMIT 100'
            ).all();
            res.json(rows);
        } finally { db.close(); }
    });

    app.get('/api/market/links', (req, res) => {
        if (!fs.existsSync(_dbPath)) return res.json([]);
        const db = new Database(_dbPath, { readonly: true });
        try {
            const rows = db.prepare(
                'SELECT discord_id,discord_name,minecraft_name,linked_at FROM discord_links ORDER BY linked_at DESC'
            ).all();
            res.json(rows);
        } finally { db.close(); }
    });

    app.delete('/api/market/links/:discord_id', (req, res) => {
        if (!fs.existsSync(_dbPath)) return res.status(404).json({ error: 'DB not found' });
        const db = new Database(_dbPath);
        try {
            const r = db.prepare('DELETE FROM discord_links WHERE discord_id=?').run(req.params.discord_id);
            res.json({ ok: r.changes > 0 });
        } finally { db.close(); }
    });

    // ---- スケジュール ----
    app.get('/api/schedule', (req, res) => {
        res.json(readScheduleConfig());
    });

    app.post('/api/schedule', (req, res) => {
        const { label, cron, warnings } = req.body;
        if (!cron) return res.status(400).json({ error: 'cron が必要です' });
        const cfg = readScheduleConfig();
        cfg.schedules.push({
            id: crypto.randomUUID().replace(/-/g, '').slice(0, 8),
            label: label || cron,
            cron,
            warnings: warnings || [],
        });
        writeScheduleConfig(cfg);
        _reloadSchedule();
        res.json({ ok: true });
    });

    app.delete('/api/schedule/:id', (req, res) => {
        const cfg = readScheduleConfig();
        const before = cfg.schedules.length;
        cfg.schedules = cfg.schedules.filter(s => s.id !== req.params.id);
        writeScheduleConfig(cfg);
        _reloadSchedule();
        res.json({ ok: cfg.schedules.length < before });
    });

    // ---- モデレーション ----

    app.post('/api/mod/kick', (req, res) => {
        const proc = _getProcess();
        if (!proc) return res.status(400).json({ error: 'サーバーが停止中です' });
        const { player, reason } = req.body;
        if (!player) return res.status(400).json({ error: 'player が必要です' });
        const online = _getOnlinePlayers().map(n => n.toLowerCase());
        if (!online.includes(player.toLowerCase())) {
            return res.status(400).json({ error: `${player} はオンラインではありません` });
        }
        proc.stdin.write(`kick ${player}${reason ? ' ' + reason : ''}\n`);
        logMod('kick', player, { reason, req });
        incrementAndEscalate(player, 'kick', proc);
        res.json({ ok: true });
    });

    app.post('/api/mod/ban', (req, res) => {
        const { player, reason } = req.body;
        if (!player) return res.status(400).json({ error: 'player が必要です' });
        const proc = _getProcess();
        if (proc) {
            proc.stdin.write(`ban ${player}${reason ? ' ' + reason : ''}\n`);
        } else {
            try { _writeBannedPlayers(player, reason, null); }
            catch (e) { return res.status(500).json({ error: 'banned-players.json への書き込み失敗: ' + e.message }); }
        }
        logMod('ban', player, { reason, req });
        res.json({ ok: true });
    });

    app.post('/api/mod/tempban', (req, res) => {
        const { player, duration, reason } = req.body;
        if (!player || !duration) return res.status(400).json({ error: 'player と duration が必要です' });
        const proc = _getProcess();
        if (proc) {
            const online = _getOnlinePlayers();
            if (online.has(player)) proc.stdin.write(`kick ${player}${reason ? ' ' + reason : ''}\n`);
            proc.stdin.write(`tempban ${player} ${duration}${reason ? ' ' + reason : ''}\n`);
        } else {
            const ms = _parseDurationMs(duration);
            if (!ms) return res.status(400).json({ error: '期間の形式が正しくありません (例: 1d, 2h)' });
            try { _writeBannedPlayers(player, reason, new Date(Date.now() + ms)); }
            catch (e) { return res.status(500).json({ error: 'banned-players.json への書き込み失敗: ' + e.message }); }
        }
        logMod('tempban', player, { reason, duration, req });
        incrementAndEscalate(player, 'tempban', proc);
        res.json({ ok: true });
    });

    app.post('/api/mod/unban', (req, res) => {
        const { player } = req.body;
        if (!player) return res.status(400).json({ error: 'player が必要です' });
        const proc = _getProcess();
        if (proc) {
            proc.stdin.write(`pardon ${player}\n`);
        } else {
            try {
                const bannedPath = path.join(_serverPath, 'banned-players.json');
                let banned = [];
                try { banned = JSON.parse(fs.readFileSync(bannedPath, 'utf8')); } catch {}
                banned = banned.filter(e => e.name.toLowerCase() !== player.toLowerCase());
                fs.writeFileSync(bannedPath, JSON.stringify(banned, null, 2), 'utf8');
            } catch (e) { return res.status(500).json({ error: 'banned-players.json の更新失敗: ' + e.message }); }
        }
        logMod('unban', player, { req });
        resetPunishmentCounts(player);
        res.json({ ok: true });
    });

    app.post('/api/mod/tempunban', (req, res) => {
        const { player } = req.body;
        if (!player) return res.status(400).json({ error: 'player が必要です' });
        const proc = _getProcess();
        if (proc) {
            proc.stdin.write(`pardon ${player}\n`);
        } else {
            try {
                const bannedPath = path.join(_serverPath, 'banned-players.json');
                let banned = [];
                try { banned = JSON.parse(fs.readFileSync(bannedPath, 'utf8')); } catch {}
                banned = banned.filter(e => e.name.toLowerCase() !== player.toLowerCase());
                fs.writeFileSync(bannedPath, JSON.stringify(banned, null, 2), 'utf8');
            } catch (e) { return res.status(500).json({ error: 'banned-players.json の更新失敗: ' + e.message }); }
        }
        logMod('tempunban', player, { req });
        resetPunishmentCounts(player);
        res.json({ ok: true });
    });

    app.get('/api/mod/settings', requireAuth, (req, res) => {
        res.json({
            kick_to_tempban:       getSetting('kick_to_tempban', '0'),
            tempban_to_ban:        getSetting('tempban_to_ban', '0'),
            auto_tempban_duration: getSetting('auto_tempban_duration', '1d'),
        });
    });

    app.post('/api/mod/settings', requireAuth, (req, res) => {
        const { kick_to_tempban, tempban_to_ban, auto_tempban_duration } = req.body;
        const set = (k, v) => _adminDb.prepare('INSERT OR REPLACE INTO mod_settings VALUES (?,?)').run(k, String(v));
        if (kick_to_tempban       !== undefined) set('kick_to_tempban',       kick_to_tempban);
        if (tempban_to_ban        !== undefined) set('tempban_to_ban',        tempban_to_ban);
        if (auto_tempban_duration !== undefined) set('auto_tempban_duration', auto_tempban_duration);
        res.json({ ok: true });
    });

    app.get('/api/mod/counts', requireAuth, (req, res) => {
        const rows = _adminDb.prepare('SELECT * FROM punishment_counts').all();
        const map = {};
        rows.forEach(r => { map[r.target] = { kick: r.kick_count, tempban: r.tempban_count }; });
        res.json(map);
    });

    app.get('/api/mod/log', (req, res) => {
        const rows = _adminDb.prepare(
            'SELECT * FROM mod_log ORDER BY created_at DESC LIMIT 200'
        ).all();
        res.json(rows);
    });

    app.post('/api/givemoney', (req, res) => {
        const proc = _getProcess();
        if (!proc) return res.status(400).json({ error: 'サーバーが停止中です' });
        const { player, amount } = req.body;
        if (!player || !amount) return res.status(400).json({ error: 'player/amount が必要です' });
        proc.stdin.write(`eco give ${player} ${amount}\n`);
        res.json({ ok: true });
    });

    // ---- HTML ----
    app.get('/', (req, res) => {
        const client = _getDiscordClient();
        const guilds = req.session.authorizedGuilds
            .map(id => client?.guilds.cache.get(id))
            .filter(Boolean)
            .map(g => ({
                id: g.id,
                name: g.name,
                icon: g.iconURL({ size: 64 }) || null,
                memberCount: g.memberCount,
            }));
        res.send(buildGuildListHTML(req.session, guilds));
    });

    app.get('/panel', (req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.send(buildHTML());
    });

    // ---- WebSocket (コンソール) ----
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', ws => {
        wsClients.add(ws);
        ws.send('[管理パネル接続]\n');
        ws.on('close', () => wsClients.delete(ws));
        ws.on('message', msg => {
            const proc = _getProcess();
            if (proc) proc.stdin.write(msg.toString().replace(/^\//, '').trim() + '\n');
        });
    });

    server.listen(port, '127.0.0.1', () => {
        console.log(`[ADMIN] 管理パネル: http://127.0.0.1:${port}`);
    });
}

function pushLogLine(line) {
    for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(line + '\n');
    }
}

// ---- エラーページ ----
function buildErrorHTML(user, title, message) {
    const avatar = user?.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;
    return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>${title} - MC管理パネル</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center}
.card{background:#16213e;border:1px solid #0f3460;border-radius:12px;padding:40px;text-align:center;max-width:480px;width:90%}
img{width:64px;height:64px;border-radius:50%;margin-bottom:16px}
h2{color:#e94560;font-size:22px;margin-bottom:12px}
p{color:#aaa;font-size:14px;line-height:1.7;margin-bottom:24px}
a{display:inline-block;padding:8px 20px;background:#0f3460;color:#90caf9;border-radius:6px;text-decoration:none;font-size:14px}
a:hover{background:#e94560;color:#fff}</style>
</head>
<body>
<div class="card">
  <img src="${avatar}" alt="">
  <h2>${title}</h2>
  <p>${message}</p>
  <a href="/auth/logout">ログアウト</a>
</div>
</body></html>`;
}

// ---- サーバー一覧ページ ----
function buildGuildListHTML(session, guilds) {
    const avatar = session.avatar
        ? `https://cdn.discordapp.com/avatars/${session.userId}/${session.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

    const cards = guilds.map(g => {
        const icon = g.icon
            ? `<img src="${g.icon}" style="width:64px;height:64px;border-radius:50%;margin-bottom:10px">`
            : `<div style="width:64px;height:64px;border-radius:50%;background:#0f3460;display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:10px">${g.name[0]}</div>`;
        return `<a href="/panel" style="text-decoration:none">
            <div style="background:#16213e;border:1px solid #0f3460;border-radius:12px;padding:24px;text-align:center;width:180px;cursor:pointer;transition:border-color .2s" onmouseover="this.style.borderColor='#e94560'" onmouseout="this.style.borderColor='#0f3460'">
                ${icon}
                <div style="color:#e0e0e0;font-weight:600;font-size:15px">${g.name}</div>
                <div style="color:#aaa;font-size:12px;margin-top:4px">${g.memberCount}人のメンバー</div>
            </div>
        </a>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>MC 管理パネル</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column;align-items:center}
header{width:100%;background:#16213e;padding:14px 32px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #0f3460}
header h1{font-size:18px;color:#e94560;flex:1}
.user-info{display:flex;align-items:center;gap:10px;font-size:14px}
.user-info img{width:36px;height:36px;border-radius:50%}
.logout{color:#aaa;font-size:13px;text-decoration:none;padding:4px 10px;border:1px solid #444;border-radius:4px}
.logout:hover{color:#e94560;border-color:#e94560}
main{flex:1;display:flex;flex-direction:column;align-items:center;padding:60px 20px}
h2{font-size:22px;margin-bottom:8px;color:#90caf9}
p{color:#aaa;margin-bottom:40px;font-size:14px}
.guild-list{display:flex;flex-wrap:wrap;gap:20px;justify-content:center}
</style>
</head>
<body>
<header>
  <h1>MC 管理パネル</h1>
  <div class="user-info">
    <img src="${avatar}" alt="">
    <span>${session.username}</span>
    <a href="/auth/logout" class="logout">ログアウト</a>
  </div>
</header>
<main>
  <h2>サーバーを選択</h2>
  <p>管理するDiscordサーバーを選んでください</p>
  <div class="guild-list">${cards}</div>
</main>
</body>
</html>`;
}

// ---- HTML テンプレート ----
function buildHTML() {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MC 管理パネル</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;height:100vh;display:flex;flex-direction:column}
header{background:#16213e;padding:12px 20px;display:flex;align-items:center;gap:16px;border-bottom:1px solid #0f3460}
header h1{font-size:18px;color:#e94560}
#statusDot{width:12px;height:12px;border-radius:50%;background:#555;flex-shrink:0}
#statusDot.online{background:#4caf50}
#statusDot.offline{background:#f44336}
#statusText{font-size:13px;color:#aaa}
.spacer{flex:1}
.btn{padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600}
.btn-green{background:#4caf50;color:#fff}
.btn-red{background:#f44336;color:#fff}
.btn-blue{background:#2196f3;color:#fff}
.btn-orange{background:#ff9800;color:#fff}
.btn-sm{padding:3px 10px;font-size:12px}
.btn:disabled{opacity:.4;cursor:not-allowed}
nav{background:#16213e;display:flex;gap:2px;padding:0 20px;border-bottom:1px solid #0f3460}
nav button{background:none;border:none;color:#aaa;padding:10px 16px;cursor:pointer;font-size:14px;border-bottom:3px solid transparent}
nav button.active{color:#e94560;border-bottom-color:#e94560}
.tab{display:none;flex:1;overflow:hidden;flex-direction:column}
.tab.active{display:flex}
/* Console */
#console-out{flex:1;overflow-y:auto;background:#0d1117;font-family:monospace;font-size:12px;padding:10px;white-space:pre-wrap;word-break:break-all}
.console-bar{display:flex;gap:8px;padding:10px;background:#16213e;border-top:1px solid #0f3460}
.console-bar input{flex:1;background:#0d1117;border:1px solid #0f3460;color:#e0e0e0;padding:6px 10px;border-radius:4px;font-family:monospace;font-size:13px}
/* Tables */
.tab-content{flex:1;overflow-y:auto;padding:16px}
.sub-tabs{display:flex;gap:8px;margin-bottom:12px}
.sub-tab{background:#0f3460;border:none;color:#aaa;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px}
.sub-tab.active{background:#e94560;color:#fff}
.sub-pane{display:none}.sub-pane.active{display:block}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#0f3460;padding:8px 10px;text-align:left;color:#90caf9}
td{padding:7px 10px;border-bottom:1px solid #1e2a3a}
tr:hover td{background:#1e2a3a}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.badge-green{background:#1b5e20;color:#a5d6a7}
.badge-red{background:#b71c1c;color:#ef9a9a}
.give-form{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.give-form input{background:#0d1117;border:1px solid #0f3460;color:#e0e0e0;padding:6px 10px;border-radius:4px;font-size:13px}
.give-form input[type=number]{width:130px}
.toast{position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}
.toast.show{opacity:1}
</style>
</head>
<body>
<header>
  <div id="statusDot"></div>
  <h1>MC 管理パネル</h1>
  <span id="statusText">確認中...</span>
  <span id="playerInfo" style="font-size:13px;color:#90caf9"></span>
  <div class="spacer"></div>
  <button class="btn btn-green" id="btnStart" disabled onclick="serverAction('start')">起動</button>
  <button class="btn btn-orange" onclick="serverAction('restart')" style="margin:0 6px">再起動</button>
  <button class="btn btn-red" id="btnStop" disabled onclick="serverAction('stop')">停止</button>
</header>
<nav>
  <button class="active" onclick="switchTab('console',this)">コンソール</button>
  <button onclick="switchTab('market',this)">マーケット</button>
  <button onclick="switchTab('players',this)">プレイヤー</button>
  <button onclick="switchTab('schedule',this)">スケジュール</button>
</nav>

<!-- コンソール -->
<div class="tab active" id="tab-console">
  <div id="console-out"></div>
  <div class="console-bar">
    <input id="cmdInput" placeholder="コマンドを入力（/ は不要）" onkeydown="if(event.key==='Enter')sendCmd()">
    <button class="btn btn-blue" onclick="sendCmd()">送信</button>
  </div>
</div>

<!-- マーケット -->
<div class="tab" id="tab-market">
  <div class="tab-content">
    <div class="sub-tabs">
      <button class="sub-tab active" onclick="switchSub('listings',this)">出品一覧</button>
      <button class="sub-tab" onclick="switchSub('transactions',this)">取引履歴</button>
    </div>
    <div class="sub-pane active" id="sub-listings">
      <button class="btn btn-blue btn-sm" onclick="loadListings()" style="margin-bottom:10px">更新</button>
      <table><thead><tr><th>ID</th><th>出品者</th><th>アイテム</th><th>残数</th><th>単価</th><th>操作</th></tr></thead>
      <tbody id="tbody-listings"></tbody></table>
    </div>
    <div class="sub-pane" id="sub-transactions">
      <button class="btn btn-blue btn-sm" onclick="loadTransactions()" style="margin-bottom:10px">更新</button>
      <table><thead><tr><th>購入者</th><th>アイテム</th><th>数量</th><th>単価</th><th>合計</th><th>出品者</th><th>日時</th></tr></thead>
      <tbody id="tbody-transactions"></tbody></table>
    </div>
  </div>
</div>

<!-- プレイヤー -->
<div class="tab" id="tab-players">
  <div class="tab-content">
    <div class="sub-tabs">
      <button class="sub-tab active" onclick="switchSub('links',this)">Discord連携</button>
      <button class="sub-tab" onclick="switchSub('moderation',this)">モデレーション</button>
    </div>

    <!-- 連携 -->
    <div class="sub-pane active" id="sub-links">
      <div class="give-form" style="margin-bottom:14px">
        <input id="givePlayer" placeholder="プレイヤー名">
        <input id="giveAmount" type="number" min="1" placeholder="金額">
        <button class="btn btn-green" onclick="giveMoney()">付与</button>
      </div>
      <button class="btn btn-blue btn-sm" onclick="loadLinks()" style="margin-bottom:10px">更新</button>
      <table><thead><tr><th>Minecraftプレイヤー</th><th>Discord</th><th>連携日時</th><th>操作</th></tr></thead>
      <tbody id="tbody-links"></tbody></table>
    </div>

    <!-- モデレーション -->
    <div class="sub-pane" id="sub-moderation">
      <div style="background:#0f3460;border-radius:8px;padding:16px">
        <div style="font-weight:600;color:#e94560;margin-bottom:12px">プレイヤー処罰</div>

        <!-- 検索 + 全選択 -->
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input id="modSearch" type="text" placeholder="名前で検索..." oninput="filterModList()"
            style="flex:1;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;font-size:13px">
          <button class="btn" id="btnSelAll" onclick="toggleSelectAll()"
            style="font-size:12px;padding:4px 12px;white-space:nowrap">全選択</button>
        </div>

        <!-- プレイヤー一覧 -->
        <div id="modPlayerList" style="max-height:280px;overflow-y:auto;border:1px solid #1e2a3a;border-radius:6px;background:#060d18;margin-bottom:8px">
          <div style="padding:20px;text-align:center;color:#555;font-size:13px">読み込み中...</div>
        </div>
        <div id="modSelCount" style="font-size:12px;color:#aaa;margin-bottom:12px">0人選択中</div>

        <!-- 理由 -->
        <div style="margin-bottom:10px">
          <label style="font-size:12px;color:#aaa">理由（省略可）</label><br>
          <input id="modReason" placeholder="ルール違反" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;margin-top:4px">
        </div>

        <!-- 参加停止期間（参加停止ボタン用・常時表示） -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <div>
            <label style="font-size:12px;color:#aaa">参加停止期間（数値）</label><br>
            <input id="modDurVal" type="number" min="1" value="1" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;margin-top:4px">
          </div>
          <div>
            <label style="font-size:12px;color:#aaa">単位</label><br>
            <select id="modDurUnit" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;margin-top:4px">
              <option value="m">分 (m)</option>
              <option value="h">時間 (h)</option>
              <option value="d" selected>日 (d)</option>
              <option value="w">週 (w)</option>
              <option value="mo">ヶ月 (mo)</option>
              <option value="y">年 (y)</option>
            </select>
          </div>
        </div>

        <!-- アクションボタン -->
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-orange" onclick="modAction('kick')">追放 (Kick)</button>
          <button class="btn btn-red" onclick="modAction('ban')">BAN</button>
          <button class="btn btn-red" onclick="modAction('tempban')" style="background:#7b1fa2">参加停止 (Tempban)</button>
        </div>
      </div>

      <!-- エスカレーション設定 -->
      <div style="background:#161b22;border:1px solid #1e2a3a;border-radius:8px;padding:16px;margin-top:12px">
        <div style="font-weight:600;color:#aaa;margin-bottom:12px;font-size:13px">⚙️ 自動エスカレーション設定</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <label style="font-size:12px;color:#aaa">追放 N 回で自動参加停止（0=無効）</label><br>
            <input id="esc-kick-count" type="number" min="0" value="0" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;margin-top:4px">
          </div>
          <div>
            <label style="font-size:12px;color:#aaa">参加停止 N 回で自動 BAN（0=無効）</label><br>
            <input id="esc-tempban-count" type="number" min="0" value="0" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;margin-top:4px">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <div>
            <label style="font-size:12px;color:#aaa">自動参加停止の期間（数値）</label><br>
            <input id="esc-dur-val" type="number" min="1" value="1" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;margin-top:4px">
          </div>
          <div>
            <label style="font-size:12px;color:#aaa">単位</label><br>
            <select id="esc-dur-unit" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px 10px;border-radius:4px;margin-top:4px">
              <option value="m">分 (m)</option>
              <option value="h">時間 (h)</option>
              <option value="d" selected>日 (d)</option>
              <option value="w">週 (w)</option>
              <option value="mo">ヶ月 (mo)</option>
            </select>
          </div>
        </div>
        <button class="btn btn-blue" onclick="saveEscSettings()" style="font-size:12px;padding:5px 16px">保存</button>
        <span id="esc-save-msg" style="font-size:12px;color:#4caf50;margin-left:10px;display:none">✅ 保存しました</span>
      </div>

      <!-- 処罰履歴 -->
      <div style="background:#0f3460;border-radius:8px;padding:16px;margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-weight:600;color:#e94560">処罰履歴</div>
          <button class="btn" onclick="loadModLog()" style="font-size:12px;padding:3px 10px">更新</button>
        </div>
        <div id="modLogTable" style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="color:#aaa;border-bottom:1px solid #1e2a3a">
                <th style="text-align:left;padding:4px 8px">日時</th>
                <th style="text-align:left;padding:4px 8px">対象</th>
                <th style="text-align:left;padding:4px 8px">処罰</th>
                <th style="text-align:left;padding:4px 8px">期間</th>
                <th style="text-align:left;padding:4px 8px">理由</th>
                <th style="text-align:left;padding:4px 8px">実行者</th>
                <th style="text-align:left;padding:4px 8px">操作</th>
              </tr>
            </thead>
            <tbody id="modLogBody">
              <tr><td colspan="6" style="padding:16px;text-align:center;color:#555">読み込み中...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- スケジュール -->
<div class="tab" id="tab-schedule">
  <div class="tab-content">
    <h3 style="margin-bottom:14px;color:#90caf9">再起動スケジュール</h3>

    <!-- 追加フォーム -->
    <div style="background:#0f3460;border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-weight:600;margin-bottom:12px;color:#e94560">新規スケジュール追加</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:12px;color:#aaa">種別</label><br>
          <select id="sch-type" onchange="onSchTypeChange()" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px;border-radius:4px;margin-top:4px">
            <option value="daily">毎日</option>
            <option value="weekly">毎週</option>
            <option value="monthly">毎月</option>
            <option value="interval">N時間ごと</option>
            <option value="custom">カスタム (cron)</option>
          </select>
        </div>
        <div id="sch-time-wrap">
          <label style="font-size:12px;color:#aaa">時刻</label><br>
          <input id="sch-time" type="time" value="03:00" style="background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px;border-radius:4px;margin-top:4px">
        </div>
        <div id="sch-dow-wrap" style="display:none">
          <label style="font-size:12px;color:#aaa">曜日</label><br>
          <select id="sch-dow" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px;border-radius:4px;margin-top:4px">
            <option value="0">日曜</option><option value="1">月曜</option><option value="2">火曜</option>
            <option value="3">水曜</option><option value="4">木曜</option><option value="5">金曜</option><option value="6">土曜</option>
          </select>
        </div>
        <div id="sch-dom-wrap" style="display:none">
          <label style="font-size:12px;color:#aaa">日</label><br>
          <input id="sch-dom" type="number" min="1" max="28" value="1" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px;border-radius:4px;margin-top:4px">
        </div>
        <div id="sch-interval-wrap" style="display:none">
          <label style="font-size:12px;color:#aaa">間隔（時間）</label><br>
          <input id="sch-interval" type="number" min="1" max="24" value="6" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px;border-radius:4px;margin-top:4px">
        </div>
        <div id="sch-cron-wrap" style="display:none">
          <label style="font-size:12px;color:#aaa">cron 式</label><br>
          <input id="sch-cron" placeholder="0 3 * * *" style="width:100%;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:6px;border-radius:4px;margin-top:4px">
        </div>
      </div>

      <!-- 警告設定 -->
      <div style="margin-top:10px">
        <div style="font-size:12px;color:#aaa;margin-bottom:6px">警告タイミング（再起動の何前に通知するか）</div>
        <div id="warnings-list" style="display:flex;flex-direction:column;gap:6px"></div>
        <button class="btn btn-blue btn-sm" onclick="addWarningRow()" style="margin-top:8px">+ 警告を追加</button>
      </div>

      <button class="btn btn-green" onclick="addSchedule()" style="margin-top:14px">追加</button>
    </div>

    <!-- 既存スケジュール一覧 -->
    <button class="btn btn-blue btn-sm" onclick="loadSchedule()" style="margin-bottom:10px">更新</button>
    <table><thead><tr><th>ラベル</th><th>cron</th><th>警告</th><th>操作</th></tr></thead>
    <tbody id="tbody-schedule"></tbody></table>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let ws;

function connectWS() {
  ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onmessage = e => {
    const out = document.getElementById('console-out');
    out.textContent += e.data;
    out.scrollTop = out.scrollHeight;
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}
connectWS();

function sendCmd() {
  const inp = document.getElementById('cmdInput');
  const cmd = inp.value.trim();
  if (!cmd) return;
  if (ws && ws.readyState === 1) { ws.send(cmd); inp.value = ''; }
}

async function serverAction(action) {
  const labels = { start:'起動', stop:'停止', restart:'再起動' };
  if (!confirm(\`サーバーを\${labels[action]}しますか？\`)) return;
  const r = await fetch('/api/'+action, { method:'POST' }).then(r=>r.json());
  showToast(r.ok ? \`✅ \${labels[action]}を実行しました\` : '❌ ' + (r.error||'失敗'));
  setTimeout(checkStatus, 2000);
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  btn.classList.add('active');
  if (name === 'market') loadListings();
  if (name === 'players') loadLinks();
  if (name === 'schedule') loadSchedule();
}

function switchSub(name, btn) {
  document.querySelectorAll('.sub-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('sub-'+name).classList.add('active');
  btn.classList.add('active');
  if (name === 'listings') loadListings();
  if (name === 'transactions') loadTransactions();
  if (name === 'links') loadLinks();
}

async function loadListings() {
  const rows = await fetch('/api/market/listings').then(r=>r.json());
  const tbody = document.getElementById('tbody-listings');
  tbody.innerHTML = rows.map(r => \`<tr>
    <td>\${r.id}</td><td>\${r.seller_name}</td><td>\${r.item_type}</td>
    <td>\${r.remaining_amount}</td><td>\${r.price_per_unit}</td>
    <td><button class="btn btn-red btn-sm" onclick="cancelListing(\${r.id})">キャンセル</button></td>
  </tr>\`).join('');
}

async function cancelListing(id) {
  if (!confirm('出品ID '+id+' をキャンセルしますか？')) return;
  const r = await fetch('/api/market/cancel/'+id, {method:'POST'}).then(r=>r.json());
  showToast(r.ok ? '✅ キャンセルしました' : '❌ 失敗しました');
  loadListings();
}

async function loadTransactions() {
  const rows = await fetch('/api/market/transactions').then(r=>r.json());
  const tbody = document.getElementById('tbody-transactions');
  tbody.innerHTML = rows.map(r => \`<tr>
    <td>\${r.buyer_name}</td><td>\${r.item_type}</td><td>\${r.amount}</td>
    <td>\${r.price_per_unit}</td><td>\${r.total_price.toFixed(0)}</td>
    <td>\${r.seller_name??'不明'}</td><td>\${new Date(r.sold_at).toLocaleString('ja-JP')}</td>
  </tr>\`).join('');
}

async function loadLinks() {
  const rows = await fetch('/api/market/links').then(r=>r.json());
  const tbody = document.getElementById('tbody-links');
  tbody.innerHTML = rows.map(r => \`<tr>
    <td>\${r.minecraft_name}</td><td>\${r.discord_name||r.discord_id}</td>
    <td>\${new Date(r.linked_at).toLocaleString('ja-JP')}</td>
    <td><button class="btn btn-red btn-sm" onclick="unlinkPlayer('\${r.discord_id}','\${r.minecraft_name}')">解除</button></td>
  </tr>\`).join('');
}

async function unlinkPlayer(id, name) {
  if (!confirm(name+' の連携を解除しますか？')) return;
  const r = await fetch('/api/market/links/'+encodeURIComponent(id), {method:'DELETE'}).then(r=>r.json());
  showToast(r.ok ? '✅ 解除しました' : '❌ 失敗しました');
  loadLinks();
}

async function giveMoney() {
  const player = document.getElementById('givePlayer').value.trim();
  const amount = document.getElementById('giveAmount').value;
  if (!player || !amount) return showToast('プレイヤー名と金額を入力してください');
  const r = await fetch('/api/givemoney', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({player,amount})}).then(r=>r.json());
  showToast(r.ok ? \`✅ \${player} に \${amount} 付与しました\` : '❌ ' + (r.error||'失敗'));
}

// ---- プレイヤーリスト ----
let knownPlayers = [];
let onlinePlayers = [];

function refreshPlayerLists(online) {
  onlinePlayers = online || [];
  renderModList();
}
fetch('/api/players/known').then(r => {
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}).then(names => {
  knownPlayers = Array.isArray(names) ? names : [];
  renderModList();
}).catch(e => {
  const el = document.getElementById('modPlayerList');
  if (el) el.innerHTML = \`<div style="padding:20px;text-align:center;color:#e57373;font-size:13px">読み込み失敗: \${e.message}</div>\`;
});

function renderModList() {
  const el = document.getElementById('modPlayerList');
  if (!el) return;
  const search = (document.getElementById('modSearch')?.value || '').toLowerCase();
  const onlineSet = new Set(onlinePlayers.map(n => n.toLowerCase()));
  let list = knownPlayers.filter(p => !search || p.toLowerCase().includes(search));
  list = list.slice().sort((a, b) => {
    const ao = onlineSet.has(a.toLowerCase()), bo = onlineSet.has(b.toLowerCase());
    if (ao !== bo) return ao ? -1 : 1;
    return a.localeCompare(b);
  });
  if (list.length === 0) {
    el.innerHTML = \`<div style="padding:20px;text-align:center;color:#555;font-size:13px">\${search ? '一致するプレイヤーなし' : 'プレイヤーなし'}</div>\`;
    updateSelCount();
    return;
  }
  el.innerHTML = list.map(p => {
    const online = onlineSet.has(p.toLowerCase());
    const dot = online ? '#4caf50' : '#555';
    const badge = online ? '<span style="font-size:10px;background:#1b5e20;color:#a5d6a7;padding:1px 6px;border-radius:10px;margin-left:4px">オンライン</span>' : '';
    return \`<label data-name="\${p}" style="display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;border-bottom:1px solid #0d1117;transition:background .1s" onmouseenter="this.style.background='#0d1a2a'" onmouseleave="this.style.background=''">\`
      + \`<input type="checkbox" class="mod-check" value="\${p}" onchange="updateSelCount()" style="accent-color:#1565c0;width:15px;height:15px">\`
      + \`<span style="width:8px;height:8px;border-radius:50%;background:\${dot};flex-shrink:0"></span>\`
      + \`<span style="flex:1;font-size:13px;color:#e0e0e0">\${p}</span>\${badge}\`
      + \`</label>\`;
  }).join('');
  updateSelCount();
}

function filterModList() { renderModList(); }

function updateSelCount() {
  const n = document.querySelectorAll('.mod-check:checked').length;
  const el = document.getElementById('modSelCount');
  if (el) el.textContent = n + '人選択中';
  const btn = document.getElementById('btnSelAll');
  if (btn) {
    const total = document.querySelectorAll('.mod-check').length;
    btn.textContent = (n > 0 && n === total) ? '全解除' : '全選択';
  }
}

function toggleSelectAll() {
  const checks = [...document.querySelectorAll('.mod-check')];
  const allChecked = checks.length > 0 && checks.every(c => c.checked);
  checks.forEach(c => c.checked = !allChecked);
  updateSelCount();
}

function getSelectedModPlayers() {
  return [...document.querySelectorAll('.mod-check:checked')].map(c => c.value);
}

// ---- エスカレーション設定 ----
async function loadEscSettings() {
  try {
    const s = await fetch('/api/mod/settings').then(r => r.json());
    document.getElementById('esc-kick-count').value    = s.kick_to_tempban || '0';
    document.getElementById('esc-tempban-count').value = s.tempban_to_ban || '0';
    const dur = s.auto_tempban_duration || '1d';
    const m = dur.match(/^(\d+)(m|h|d|w|mo)$/);
    if (m) {
      document.getElementById('esc-dur-val').value  = m[1];
      document.getElementById('esc-dur-unit').value = m[2];
    }
  } catch {}
}
async function saveEscSettings() {
  const kick_to_tempban       = parseInt(document.getElementById('esc-kick-count').value, 10) || 0;
  const tempban_to_ban        = parseInt(document.getElementById('esc-tempban-count').value, 10) || 0;
  const auto_tempban_duration = document.getElementById('esc-dur-val').value + document.getElementById('esc-dur-unit').value;
  const r = await fetch('/api/mod/settings', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ kick_to_tempban, tempban_to_ban, auto_tempban_duration })
  }).then(res => res.json());
  if (r.ok) {
    const msg = document.getElementById('esc-save-msg');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  }
}
loadEscSettings();

// ---- モデレーション ----

async function modAction(action) {
  const players = getSelectedModPlayers();
  if (players.length === 0) return showToast('プレイヤーを選択してください');
  if (action === 'kick') {
    const offlines = players.filter(p => !onlinePlayers.map(n=>n.toLowerCase()).includes(p.toLowerCase()));
    if (offlines.length > 0) return showToast('追放はオンラインのみ可能: ' + offlines.join(', '));
  }
  const labels = { kick:'追放', ban:'BAN', tempban:'参加停止', unban:'BAN解除' };
  const reason = document.getElementById('modReason').value.trim();
  const plural = players.length > 1 ? \`\${players.length}人\` : players[0];

  if (action === 'tempban') {
    const val = parseInt(document.getElementById('modDurVal').value, 10);
    const unit = document.getElementById('modDurUnit').value;
    if (!val || val < 1) return showToast('参加停止期間を入力してください');
    const duration = val + unit;
    const reasonText = reason ? \`\\n理由: \${reason}\` : '';
    if (!confirm(\`\${plural} を \${duration} 間参加停止にしますか？\${reasonText}\`)) return;
    const results = await Promise.all(players.map(player =>
      fetch('/api/mod/tempban', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ player, duration, reason })
      }).then(r=>r.json()).then(r => ({player, ok: r.ok, error: r.error}))
    ));
    const failed = results.filter(r => !r.ok);
    if (failed.length === 0) { showToast(\`✅ \${plural} を \${duration} 参加停止しました\`); loadModLog(); }
    else showToast(\`❌ 失敗: \${failed.map(r=>r.player+': '+r.error).join(' / ')}\`);
    return;
  }

  const actionLabels = {
    kick:  \`\${plural} を追放しますか？\`,
    ban:   \`\${plural} をBANしますか？（永久）\`,
    unban: \`\${plural} のBANを解除しますか？\`,
  };
  if (!confirm(actionLabels[action])) return;

  const results = await Promise.all(players.map(player =>
    fetch(\`/api/mod/\${action}\`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ player, reason })
    }).then(r=>r.json()).then(r => ({player, ok: r.ok, error: r.error}))
  ));
  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) { showToast(\`✅ \${plural} を\${labels[action]}しました\`); loadModLog(); }
  else showToast(\`❌ 失敗: \${failed.map(r=>r.player+': '+r.error).join(' / ')}\`);
}

async function tempunbanPlayer(player) {
  if (!confirm(\`\${player} の参加停止を解除しますか？\`)) return;
  const r = await fetch('/api/mod/tempunban', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ player })
  }).then(res=>res.json());
  if (r.ok) { showToast(\`✅ \${player} の参加停止を解除しました\`); loadModLog(); }
  else showToast(\`❌ 失敗: \${r.error}\`);
}

async function unbanPlayer(player) {
  if (!confirm(\`\${player} の BAN を解除しますか？\`)) return;
  const r = await fetch('/api/mod/unban', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ player })
  }).then(res=>res.json());
  if (r.ok) { showToast(\`✅ \${player} の BAN を解除しました\`); loadModLog(); }
  else showToast(\`❌ 失敗: \${r.error}\`);
}

// ---- 処罰履歴 ----
const modActionLabels = { kick:'追放', ban:'BAN', tempban:'参加停止', unban:'BAN解除', tempunban:'参加停止解除' };
async function loadModLog() {
  const tbody = document.getElementById('modLogBody');
  if (!tbody) return;
  try {
    const rows = await fetch('/api/mod/log').then(r => r.json());
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;text-align:center;color:#555">履歴なし</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const d = new Date(r.created_at);
      const dt = d.toLocaleDateString('ja-JP') + ' ' + d.toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'});
      const clr = {kick:'#ffb74d',ban:'#e57373',tempban:'#ce93d8',unban:'#90caf9',tempunban:'#80cbc4'}[r.action]||'#e0e0e0';
      const opCell = r.action === 'tempban'
        ? \`<td style="padding:5px 8px"><button class="btn btn-sm" onclick="tempunbanPlayer('\${r.target}')" style="background:#00838f;padding:2px 8px;font-size:11px">解除</button></td>\`
        : r.action === 'ban'
        ? \`<td style="padding:5px 8px"><button class="btn btn-sm" onclick="unbanPlayer('\${r.target}')" style="background:#1565c0;padding:2px 8px;font-size:11px">BAN解除</button></td>\`
        : '<td></td>';
      return \`<tr style="border-bottom:1px solid #0d1117">
        <td style="padding:5px 8px;color:#777;white-space:nowrap">\${dt}</td>
        <td style="padding:5px 8px;color:#e0e0e0;font-weight:600">\${r.target}</td>
        <td style="padding:5px 8px;color:\${clr}">\${modActionLabels[r.action]||r.action}</td>
        <td style="padding:5px 8px;color:#aaa">\${r.duration||'-'}</td>
        <td style="padding:5px 8px;color:#aaa">\${r.reason||'-'}</td>
        <td style="padding:5px 8px;color:#777">\${r.admin_username||'-'}</td>
        \${opCell}
      </tr>\`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = \`<tr><td colspan="6" style="padding:16px;text-align:center;color:#e57373">読み込み失敗: \${e.message}</td></tr>\`;
  }
}
loadModLog();

// ---- スケジュール ----
function onSchTypeChange() {
  const t = document.getElementById('sch-type').value;
  document.getElementById('sch-time-wrap').style.display     = ['daily','weekly','monthly'].includes(t) ? '' : 'none';
  document.getElementById('sch-dow-wrap').style.display      = t === 'weekly'   ? '' : 'none';
  document.getElementById('sch-dom-wrap').style.display      = t === 'monthly'  ? '' : 'none';
  document.getElementById('sch-interval-wrap').style.display = t === 'interval' ? '' : 'none';
  document.getElementById('sch-cron-wrap').style.display     = t === 'custom'   ? '' : 'none';
}

function addWarningRow() {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px;align-items:center';
  div.innerHTML = \`<input type="number" min="1" value="1" style="width:70px;background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:5px;border-radius:4px">
    <select style="background:#0d1117;color:#e0e0e0;border:1px solid #1e2a3a;padding:5px;border-radius:4px">
      <option value="minutes">分</option>
      <option value="hours" selected>時間</option>
      <option value="days">日</option>
      <option value="months">ヶ月</option>
    </select>
    <span style="color:#aaa;font-size:12px">前</span>
    <button class="btn btn-red btn-sm" onclick="this.parentElement.remove()">✕</button>\`;
  document.getElementById('warnings-list').appendChild(div);
}

function buildCron() {
  const t = document.getElementById('sch-type').value;
  const time = document.getElementById('sch-time').value || '03:00';
  const [hh, mm] = time.split(':');
  const h = parseInt(hh), m = parseInt(mm);
  if (t === 'daily')    return \`\${m} \${h} * * *\`;
  if (t === 'weekly')   return \`\${m} \${h} * * \${document.getElementById('sch-dow').value}\`;
  if (t === 'monthly')  return \`\${m} \${h} \${document.getElementById('sch-dom').value} * *\`;
  if (t === 'interval') return \`0 */\${document.getElementById('sch-interval').value} * * *\`;
  return document.getElementById('sch-cron').value.trim();
}

function buildLabel() {
  const t = document.getElementById('sch-type').value;
  const time = document.getElementById('sch-time').value || '03:00';
  const days = ['日','月','火','水','木','金','土'];
  if (t === 'daily')    return \`毎日 \${time}\`;
  if (t === 'weekly')   return \`毎週\${days[document.getElementById('sch-dow').value]}曜 \${time}\`;
  if (t === 'monthly')  return \`毎月\${document.getElementById('sch-dom').value}日 \${time}\`;
  if (t === 'interval') return \`\${document.getElementById('sch-interval').value}時間ごと\`;
  return document.getElementById('sch-cron').value.trim();
}

function getWarnings() {
  return [...document.getElementById('warnings-list').children].map(row => {
    const inputs = row.querySelectorAll('input,select');
    return { value: parseInt(inputs[0].value), unit: inputs[1].value };
  });
}

async function addSchedule() {
  const cron = buildCron();
  if (!cron) return showToast('cron式を入力してください');
  const r = await fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: buildLabel(), cron, warnings: getWarnings() })
  }).then(r => r.json());
  showToast(r.ok ? '✅ スケジュールを追加しました' : '❌ ' + (r.error || '失敗'));
  if (r.ok) { loadSchedule(); document.getElementById('warnings-list').innerHTML = ''; }
}

async function deleteSchedule(id, label) {
  if (!confirm(\`「\${label}」を削除しますか？\`)) return;
  const r = await fetch('/api/schedule/' + id, { method: 'DELETE' }).then(r => r.json());
  showToast(r.ok ? '✅ 削除しました' : '❌ 失敗');
  if (r.ok) loadSchedule();
}

async function loadSchedule() {
  const { schedules } = await fetch('/api/schedule').then(r => r.json());
  const unitLabel = { minutes:'分', hours:'時間', days:'日', months:'ヶ月' };
  document.getElementById('tbody-schedule').innerHTML = schedules.map(s => {
    const warnText = (s.warnings || []).map(w => \`\${w.value}\${unitLabel[w.unit]||w.unit}前\`).join('、') || 'なし';
    return \`<tr>
      <td>\${s.label}</td><td><code>\${s.cron}</code></td><td>\${warnText}</td>
      <td><button class="btn btn-red btn-sm" onclick="deleteSchedule('\${s.id}','\${s.label}')">削除</button></td>
    </tr>\`;
  }).join('');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ステータス定期確認
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) {
      document.getElementById('statusText').textContent = '再認証が必要です';
      setTimeout(() => location.href = '/auth/discord', 1500);
      return;
    }
    if (!res.ok) {
      document.getElementById('statusText').textContent = 'エラー(' + res.status + ')';
      return;
    }
    const { online, playerCount, players } = await res.json();
    document.getElementById('statusDot').className = online ? 'online' : 'offline';
    document.getElementById('statusText').textContent = online ? 'オンライン' : 'オフライン';
    document.getElementById('btnStart').disabled = online;
    document.getElementById('btnStop').disabled = !online;
    const info = document.getElementById('playerInfo');
    if (online) {
      info.title = players.join(', ') || '';
      info.textContent = \`👥 \${playerCount}人\${players.length ? ' (' + players.join(', ') + ')' : ''}\`;
    } else {
      info.textContent = '';
    }
    refreshPlayerLists(online ? players : []);
  } catch(e) {
    document.getElementById('statusText').textContent = '接続エラー: ' + e.message;
  }
}
checkStatus();
setInterval(checkStatus, 5000);
</script>
</body>
</html>`;
}

module.exports = { startAdminPanel, pushLogLine };
