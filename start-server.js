// .envファイルから設定を読み込む
require('dotenv').config();

// 必要なモジュールをインポート
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const schedule = require('node-schedule');
const iconv = require('iconv-lite'); // 文字化け対策
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

const { startAdminPanel, pushLogLine } = require('./admin-panel');

// better-sqlite3: DynamicMarket DBをDiscordから直接読むためにオプションで使用
// インストール: npm install better-sqlite3
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* 未インストールの場合はスキップ */ }

// --- 設定 ---
// 1. サーバーの起動コマンド
const serverCommand = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';

// 2. サーバーの起動引数
// === Mohist ===
const MOHIST_JAR = 'mohist-1.20.1-95dd6ece-server-patched.jar';
const jvmArgs = (() => {
    try { return fs.readFileSync('user_jvm_args.txt','utf-8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')); }
    catch { return ['-Xms2G','-Xmx8G']; }
})();
const serverArgs = [...jvmArgs, '-jar', MOHIST_JAR, '--nogui'];
// === Forge (旧設定・使用しない) ===
// const serverArgs = ['@user_jvm_args.txt', '@libraries/net/minecraftforge/forge/1.20.1-47.4.0/win_args.txt'];

// 6. DynamicMarketデータベースパス (Phase 4: /market Discordコマンド用)
const MARKET_DB_PATH = path.join(__dirname, 'plugins', 'DynamicMarket', 'market.db');

// 3. Discord設定 ( .env から読み込み)
const discordBotToken = process.env.DISCORD_BOT_TOKEN;
const discordChannelId = process.env.DISCORD_CHANNEL_ID;
const adminRoleId = process.env.ADMIN_ROLE_ID;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

// 4. 再起動スケジュール
const SCHEDULE_CONFIG_PATH = path.join(__dirname, 'schedule-config.json');
let activeScheduleJobs = []; // キャンセル用に保持

function loadScheduleConfig() {
    try {
        return JSON.parse(fs.readFileSync(SCHEDULE_CONFIG_PATH, 'utf-8'));
    } catch {
        return { schedules: [] };
    }
}

// 5. 再起動ディレイ
const restartDelay = 10;

// --- ここまで ---


// --- グローバル変数 ---
const e4mcRegex        = /Domain assigned: ([\w.-]+\.e4mc\.link)/i;
const chatRegex        = /INFO\]: <([\w§]+)> (.*)/;
const marketResultRegex = /\[MARKET_RESULT\] (\S+) (OK|FAIL|LIST) (.*)/;

const statusMessageIdFile = 'discord_message_id.txt';
const warningMessageIdFile = 'discord_warning_id.txt';
const crashMessageIdFile = 'discord_crash_id.txt';

let serverProcess = null;
let serverReady = false;   // true = 起動完了済み（Doneログ検出後）
let isManualStop = false;  // true = /stop による意図的な停止
let e4mcIp = null;
let lineBuffer = '';
let mcCaptureLines = null; // stdout一時キャプチャ用
let onlinePlayers  = new Set(); // オンラインプレイヤー追跡
let isScheduledRestart = false;
let isCrashLoopPaused = false; // クラッシュループ検知時に true になる

// クラッシュループ検知用
const CRASH_LOOP_LIMIT = 3;
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000; // 5分以内
let recentCrashTimestamps = [];

// Discord /market buy|sell コマンドの応答待ちマップ: txId -> { interaction, timer }
const pendingMarketRequests = new Map();

// ゾーン情報読み込み（zones.yml から）
function readZones() {
    try {
        const zonesPath = path.join(__dirname, 'plugins', 'ZoneManager', 'zones.yml');
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

// --- スラッシュコマンドの定義 ---
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('マインクラフトサーバーを起動します。'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('マインクラフトサーバーを停止します。（自動再起動なし）'),
    new SlashCommandBuilder()
        .setName('restart')
        .setDescription('マインクラフトサーバーを再起動します。'),
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('DiscordアカウントをMinecraftアカウントと連携する'),
    new SlashCommandBuilder()
        .setName('market')
        .setDescription('Dynamic Market - プレイヤー間フリーマーケット')
        .addSubcommand(sub => sub
            .setName('price')
            .setDescription('アイテムの市場価格を確認する（取引履歴から算出・オフライン可）')
            .addStringOption(opt => opt
                .setName('item').setDescription('アイテムタイプ (例: DIAMOND, IRON_SWORD)').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('現在の出品一覧（オフライン可）')
            .addStringOption(opt => opt
                .setName('item').setDescription('絞り込むアイテムタイプ (省略可)').setRequired(false))
            .addIntegerOption(opt => opt
                .setName('page').setDescription('ページ番号').setRequired(false).setMinValue(1)))
        .addSubcommand(sub => sub
            .setName('buy')
            .setDescription('出品IDを指定して購入する（連携済み・サーバー起動中必須）')
            .addIntegerOption(opt => opt
                .setName('id').setDescription('出品ID (/market list で確認)').setRequired(true).setMinValue(1))
            .addIntegerOption(opt => opt
                .setName('qty').setDescription('購入数量（省略すると全量）').setRequired(false).setMinValue(1))),
    new SlashCommandBuilder()
        .setName('givemoney')
        .setDescription('プレイヤーに金額を付与する（管理者専用・サーバー起動中必須）')
        .addStringOption(opt => opt
            .setName('player').setDescription('プレイヤー名').setRequired(true))
        .addNumberOption(opt => opt
            .setName('amount').setDescription('付与する金額').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder()
        .setName('mc')
        .setDescription('Minecraftサーバーにコマンドを送信する（管理者専用）')
        .addStringOption(opt => opt
            .setName('command')
            .setDescription('実行するコマンド（/ は不要）')
            .setRequired(true)),
    new SlashCommandBuilder()
        .setName('zone')
        .setDescription('ゾーン（土地）情報を確認する')
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('全ゾーン一覧を表示する'))
        .addSubcommand(sub => sub
            .setName('info')
            .setDescription('特定ゾーンの詳細を表示する')
            .addStringOption(opt => opt
                .setName('name').setDescription('ゾーン名').setRequired(true))),
    new SlashCommandBuilder()
        .setName('db')
        .setDescription('データベース管理（管理者専用）')
        .addSubcommand(sub => sub
            .setName('links')
            .setDescription('Discord連携一覧を表示'))
        .addSubcommand(sub => sub
            .setName('unlink')
            .setDescription('連携を解除する')
            .addStringOption(opt => opt
                .setName('target').setDescription('Minecraftプレイヤー名 または Discord名').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('listings')
            .setDescription('出品一覧を表示')
            .addStringOption(opt => opt
                .setName('item').setDescription('アイテムで絞り込み（省略可）').setRequired(false)))
        .addSubcommand(sub => sub
            .setName('cancel')
            .setDescription('出品を強制キャンセル（アイテムは返却されません）')
            .addIntegerOption(opt => opt
                .setName('id').setDescription('出品ID').setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub
            .setName('history')
            .setDescription('取引履歴を表示')
            .addStringOption(opt => opt
                .setName('player').setDescription('プレイヤーで絞り込み（省略可）').setRequired(false))),
].map(command => command.toJSON());

// --- Discord APIへのコマンド登録 (ギルドコマンド) ---
if (discordBotToken && clientId && guildId) {
    console.log('[DISCORD BOT DEBUG] CLIENT_ID:', clientId);
    console.log('[DISCORD BOT DEBUG] GUILD_ID:', guildId);

    const rest = new REST({ version: '10' }).setToken(discordBotToken);
    (async () => {
        try {
            console.log('[DISCORD BOT] スラッシュコマンド (/) をギルドに登録中です...');
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: commands },
            );
            console.log('[DISCORD BOT] スラッシュコマンドが正常に登録されました。');
        } catch (error) {
            console.error('[DISCORD BOT] スラッシュコマンドの登録に失敗しました:', error);
        }
    })();
} else {
    console.warn('[DISCORD BOT] BOTトークン, ClientID, GuildID のいずれかが未設定のため、スラッシュコマンドの登録をスキップします。');
}


// --- Discord BOT のセットアップ ---
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

discordClient.once('clientReady', async () => {
    console.log(`[DISCORD BOT] ログインしました: ${discordClient.user.tag}`);

    // Bot起動時: チャンネル内の過去のBotメッセージをすべて削除
    const channel = await getChannel();
    if (channel) {
        try {
            let deleted = 0;
            let lastId = undefined;
            while (true) {
                const opts = { limit: 100 };
                if (lastId) opts.before = lastId;
                const messages = await channel.messages.fetch(opts);
                if (messages.size === 0) break;

                const TARGET_TITLES = ['Bot 起動完了', '🟢 サーバー起動中', '⚙️ サーバー起動処理中...', '🛑 サーバー停止完了'];
                const botMsgs = messages.filter(m =>
                    m.author.id === discordClient.user.id &&
                    m.embeds.some(e => TARGET_TITLES.includes(e.title))
                );
                const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

                // 14日以内はbulkDelete、それ以降は個別削除
                const recent = botMsgs.filter(m => m.createdTimestamp > twoWeeksAgo);
                const old    = botMsgs.filter(m => m.createdTimestamp <= twoWeeksAgo);

                if (recent.size >= 2) {
                    await channel.bulkDelete(recent).catch(() => {});
                    deleted += recent.size;
                } else if (recent.size === 1) {
                    await recent.first().delete().catch(() => {});
                    deleted += 1;
                }
                for (const msg of old.values()) {
                    await msg.delete().catch(() => {});
                    deleted++;
                }

                lastId = messages.last().id;
                if (messages.size < 100) break;
            }
            console.log(`[DISCORD BOT] 過去のBotメッセージを ${deleted} 件削除しました`);
        } catch (err) {
            console.error('[DISCORD BOT] メッセージ削除エラー:', err.message);
        }

        const embed = new EmbedBuilder()
            .setTitle('Bot 起動完了')
            .setDescription('管理Botが起動しました。\nマインクラフトサーバーは停止中です。\n`/start` コマンドで起動できます。')
            .setColor(0x95A5A6)
            .addFields({ name: '起動時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>` });
        channel.send({ embeds: [embed] }).catch(err => {
            console.error('[DISCORD BOT] Bot起動通知の送信に失敗:', err.message);
        });
    }

    // 再起動スケジュールを設定
    setupRestartSchedule();
});

// messageCreate は「チャット転送専用」
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== discordChannelId) return;

    // --- チャット転送 (Discord -> MC) ---
    try {
        if (!serverProcess || !serverProcess.stdin) return;

        const tellrawJson = JSON.stringify([
            { text: "[Discord] ", color: "blue" },
            { text: message.author.displayName, color: "white" },
            { text: ": ", color: "gray" },
            { text: message.content, color: "white" }
        ]);
        serverProcess.stdin.write(`tellraw @a ${tellrawJson}\n`);
    } catch (error) {
        console.error('[DISCORD BOT] マイクラへのメッセージ転送に失敗:', error);
    }
});

// interactionCreate (スラッシュコマンド + ボタン)
discordClient.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('copy_ip:')) {
            const ip = interaction.customId.slice('copy_ip:'.length);
            return interaction.reply({
                content: `📋 接続先IP:\n\`\`\`\n${ip}\n\`\`\`\nコードブロックを長押し（またはタップ）してコピーしてください。`,
                ephemeral: true
            });
        }
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.channel.id !== discordChannelId) {
        return interaction.reply({ content: 'このチャンネルではコマンドを実行できません。', ephemeral: true });
    }

    const { commandName } = interaction;

    // /market price, /market list, /link, /zone は誰でも使える
    const isPublicCmd = commandName === 'link' || commandName === 'zone' ||
        (commandName === 'market' && ['price', 'list'].includes(interaction.options.getSubcommand(false)));

    if (!isPublicCmd && adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
        return interaction.reply({ content: 'このコマンドを実行する権限がありません。', ephemeral: true });
    }

    // (A') 連携コマンド
    if (commandName === 'link') {
        return handleLinkCommand(interaction);
    }

    // (A) 起動コマンド
    if (commandName === 'start') {
        if (serverProcess) {
            return interaction.reply({ content: 'サーバーは既に起動しています。', ephemeral: true });
        }
        isCrashLoopPaused = false;
        await interaction.reply({ content: '⚙️ 起動処理を開始します...', ephemeral: true });
        startServer();
        return;
    }

    // (B) 停止コマンド
    if (commandName === 'stop') {
        if (!serverProcess) {
            return interaction.reply({ content: 'サーバーは既に停止しています。', ephemeral: true });
        }
        isScheduledRestart = false;
        stopServer();
        return interaction.reply({ content: '🛑 停止処理を開始します...', ephemeral: true });
    }

    // (C) 再起動コマンド
    if (commandName === 'restart') {
        if (!serverProcess) {
            isCrashLoopPaused = false;
            await interaction.reply({ content: '⚙️ 起動処理を開始します...', ephemeral: true });
            startServer();
            return;
        }
        isScheduledRestart = true;
        isCrashLoopPaused = false;
        serverProcess.stdin.write('say サーバーは 10秒後 に再起動します。\n');
        setTimeout(() => stopServer(), 10000);
        return interaction.reply({ content: '🔄 10秒後にサーバーを再起動します。' });
    }

    // (D''') 所持金付与
    if (commandName === 'givemoney') {
        if (!serverProcess) {
            return interaction.reply({ content: '❌ サーバーが起動していません。', ephemeral: true });
        }
        const player = interaction.options.getString('player');
        const amount = interaction.options.getNumber('amount');
        await interaction.deferReply({ ephemeral: true });
        const lines = await captureOutput(`eco give ${player} ${amount}`, 1200);
        const msg = formatCapturedOutput(lines);
        return interaction.editReply({ content: `eco give ${player} ${amount}\n${msg}` });
    }

    // (D'') MCコマンド実行
    if (commandName === 'mc') {
        if (!serverProcess) {
            return interaction.reply({ content: '❌ サーバーが起動していません。', ephemeral: true });
        }
        const cmd = interaction.options.getString('command').replace(/^\//, '');
        await interaction.deferReply({ ephemeral: true });
        const lines = await captureOutput(cmd, 1200);
        const msg = formatCapturedOutput(lines);
        return interaction.editReply({ content: `\`${cmd}\`\n${msg}` });
    }

    // (Z) ゾーンコマンド
    if (commandName === 'zone') {
        const sub = interaction.options.getSubcommand();
        const zones = readZones();
        const entries = Object.values(zones);

        if (sub === 'list') {
            if (entries.length === 0) {
                return interaction.reply({ content: '登録されているゾーンはありません。', ephemeral: true });
            }

            const ADMIN_COLOR = 0xf85149;
            const lines = entries.map(z => {
                const owner = z.owner_uuid ? z.owner_name : '**[管理]**';
                const exp   = z.explosion_protected ? '🛡' : '　';
                const sale  = z.sell_price > 0 ? ` 💰${z.sell_price.toLocaleString()}` : '';
                return `${exp} **${z.name}** › ${owner}${sale}`;
            });

            const PER_PAGE = 15;
            const page1 = lines.slice(0, PER_PAGE).join('\n');
            const more  = lines.length > PER_PAGE ? `\n…他 ${lines.length - PER_PAGE} 件` : '';

            const embed = new EmbedBuilder()
                .setTitle('🗺 ゾーン一覧')
                .setColor(0x58a6ff)
                .setDescription(page1 + more)
                .setFooter({ text: `合計 ${entries.length} ゾーン | 詳細: /zone info <名前>` });

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'info') {
            const name = interaction.options.getString('name');
            const z = zones[name];
            if (!z) {
                return interaction.reply({
                    content: `ゾーン **${name}** が見つかりません。\`/zone list\` で一覧を確認してください。`,
                    ephemeral: true
                });
            }
            const isAdmin = !z.owner_uuid;
            const color = isAdmin ? 0xf85149 : (z.sell_price > 0 ? 0xd29922 : (z.explosion_protected ? 0x3fb950 : 0x388bfd));
            const embed = new EmbedBuilder()
                .setTitle(`🏠 ${z.name}`)
                .setColor(color)
                .addFields(
                    { name: '所有者',    value: isAdmin ? '🔴 管理者ゾーン' : z.owner_name, inline: true },
                    { name: '爆発保護',  value: z.explosion_protected ? '✅ 有効' : '❌ 無効', inline: true },
                    { name: '販売',      value: z.sell_price > 0 ? `💰 ${Number(z.sell_price).toLocaleString()}` : '非売品', inline: true },
                    { name: 'ワールド',  value: z.world || 'world', inline: true },
                    { name: '座標1',     value: `(${z.x1}, ${z.y1}, ${z.z1})`, inline: true },
                    { name: '座標2',     value: `(${z.x2}, ${z.y2}, ${z.z2})`, inline: true },
                );
            return interaction.reply({ embeds: [embed] });
        }
    }

    // (D') DB管理コマンド
    if (commandName === 'db') {
        return handleDbCommand(interaction);
    }

    // (D) マーケットコマンド
    if (commandName === 'market') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'price' || sub === 'list') {
            return handleMarketReadCommand(interaction, sub);
        }
        if (sub === 'buy') {
            if (!serverProcess) {
                return interaction.reply({
                    content: '❌ サーバーが起動していません。`/start` で起動後に再試行してください。',
                    ephemeral: true
                });
            }
            return handleMarketTradeCommand(interaction);
        }
    }
});


// BOTのログイン
if (discordBotToken && discordChannelId && clientId && guildId) {
    discordClient.login(discordBotToken).catch(err => {
        console.error('[DISCORD BOT] ログインに失敗しました:', err.message);
    });
} else {
    console.warn('[DISCORD BOT] BOTトークン, チャンネルID, ClientID, GuildID のいずれかが未設定です。Discord通知は無効です。');
}


// --- Discord Bot 通知関連の関数 ---

/**
 * 通知を送信するチャンネルを取得する
 */
async function getChannel() {
    if (!discordClient.isReady()) return null;
    try {
        return await discordClient.channels.fetch(discordChannelId);
    } catch (error) {
        console.error('[SCRIPT] チャンネルの取得に失敗しました:', error.message);
        return null;
    }
}

/**
 * 指定されたファイルからメッセージIDを読み込む
 */
function readMessageId(filename) {
    try {
        if (fs.existsSync(filename)) {
            return fs.readFileSync(filename, 'utf-8').trim();
        }
    } catch (error) {
        console.error(`[SCRIPT] メッセージIDの読み込みに失敗 (${filename}):`, error.message);
    }
    return null;
}

/**
 * 指定されたファイルにメッセージIDを保存する
 */
function saveMessageId(newMessageId, filename) {
    try {
        fs.writeFileSync(filename, newMessageId, 'utf-8');
    } catch (error) {
        console.error(`[SCRIPT] 新しいメッセージIDの保存に失敗 (${filename}):`, error.message);
    }
}

/**
 * 指定されたメッセージIDのDiscordメッセージを削除する
 */
async function deleteMessage(messageId, logPrefix = '古いメッセージ') {
    if (!messageId) return;
    const channel = await getChannel();
    if (!channel) return;

    try {
        const msg = await channel.messages.fetch(messageId);
        await msg.delete();
        console.log(`[SCRIPT] ${logPrefix}を削除しました。`);
    } catch (error) {
        if (error.code === 10008) {
            console.log(`[SCRIPT] ${logPrefix}は既に削除されていました。`);
        } else {
            console.error(`[SCRIPT] ${logPrefix}の削除に失敗しました:`, error.message);
        }
    }
}

/**
 * 起動中ステータスメッセージを削除してIDファイルをクリアする
 * ID が失われていてもチャンネルスキャンで確実に削除する
 */
async function deleteStatusMessage() {
    const messageId = readMessageId(statusMessageIdFile);
    if (messageId) {
        await deleteMessage(messageId, '起動中ステータスメッセージ');
        saveMessageId('', statusMessageIdFile);
    }

    const channel = await getChannel();
    if (!channel) return;
    try {
        let lastId;
        while (true) {
            const opts = { limit: 100 };
            if (lastId) opts.before = lastId;
            const messages = await channel.messages.fetch(opts);
            if (messages.size === 0) break;
            for (const m of messages.values()) {
                if (m.author.id === discordClient.user?.id &&
                    m.embeds.some(e => e.title === '🟢 サーバー起動中' || e.title === '⚙️ サーバー起動処理中...')) {
                    await m.delete().catch(() => {});
                }
            }
            lastId = messages.last().id;
            if (messages.size < 100) break;
        }
    } catch {}
}

/**
 * サーバー起動処理中ステータスを送信する（オレンジ）
 * e4mc IP判明後に sendToDiscord() で緑に更新される
 */
const PRE_START_TITLES = ['Bot 起動完了', '🛑 サーバー停止完了'];

async function deleteBotStartupMessage() {
    const channel = await getChannel();
    if (!channel) return;
    try {
        let lastId;
        while (true) {
            const opts = { limit: 100 };
            if (lastId) opts.before = lastId;
            const messages = await channel.messages.fetch(opts);
            if (messages.size === 0) break;
            for (const m of messages.values()) {
                if (m.author.id === discordClient.user?.id &&
                    m.embeds.some(e => PRE_START_TITLES.includes(e.title))) {
                    await m.delete().catch(() => {});
                }
            }
            lastId = messages.last().id;
            if (messages.size < 100) break;
        }
    } catch (e) {
        console.error('[DISCORD BOT] 起動前メッセージ削除エラー:', e.message);
    }
}

async function sendStartingStatus() {
    const channel = await getChannel();
    if (!channel) return;

    // Bot起動完了メッセージを削除
    await deleteBotStartupMessage();

    // 既存のステータスメッセージがあれば削除
    await deleteStatusMessage();

    const embed = new EmbedBuilder()
        .setTitle('⚙️ サーバー起動処理中...')
        .setDescription('サーバーが起動しています。しばらくお待ちください。')
        .setColor(0xF39C12)
        .addFields({ name: '起動開始時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>` });

    try {
        const msg = await channel.send({ embeds: [embed] });
        saveMessageId(msg.id, statusMessageIdFile);
        console.log(`[SCRIPT] 起動中ステータスを送信しました。(ID: ${msg.id})`);
    } catch (error) {
        console.error('[SCRIPT] 起動中ステータスの送信に失敗しました:', error.message);
    }
}

/**
 * e4mc IP判明時に起動中ステータスメッセージを緑に更新する
 */
async function sendToDiscord(ipAddress) {
    const channel = await getChannel();
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setTitle('🟢 サーバー起動中')
        .setDescription(`**接続先IP:**\n\`${ipAddress}\``)
        .setColor(0x2ECC71)
        .addFields({ name: '起動完了時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>` });

    const copyButton = new ButtonBuilder()
        .setCustomId(`copy_ip:${ipAddress}`)
        .setLabel('📋 IPをコピー')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(copyButton);

    const messageId = readMessageId(statusMessageIdFile);
    try {
        if (messageId) {
            const msg = await channel.messages.fetch(messageId);
            await msg.edit({ embeds: [embed], components: [row] });
            console.log('[SCRIPT] 起動中ステータスメッセージを更新しました。');
        } else {
            const msg = await channel.send({ embeds: [embed], components: [row] });
            saveMessageId(msg.id, statusMessageIdFile);
            console.log(`[SCRIPT] 起動中ステータスを新規送信しました。(ID: ${msg.id})`);
        }
    } catch (error) {
        console.error('[SCRIPT] 起動中ステータスの更新に失敗しました:', error.message);
    }
}

/**
 * クラッシュ通知（赤）を送信する
 */
async function notifyDiscordCrash() {
    const channel = await getChannel();
    if (!channel) return;

    const oldCrashId = readMessageId(crashMessageIdFile);
    await deleteMessage(oldCrashId, '古いクラッシュ通知');

    const embed = new EmbedBuilder()
        .setTitle('サーバーダウン')
        .setDescription(`サーバーが予期せず停止しました。\n${restartDelay}秒後に自動で再起動を試みます。`)
        .setColor(0xE74C3C)
        .addFields({ name: '停止時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>` });

    try {
        const msg = await channel.send({ content: '🚨 サーバーが停止しました 🚨', embeds: [embed] });
        saveMessageId(msg.id, crashMessageIdFile);
        console.log(`[SCRIPT] Discordへのサーバー停止通知に成功しました。(ID: ${msg.id})`);
    } catch (error) {
        console.error('[SCRIPT] Discordへの停止通知に失敗しました:', error.message);
    }
}

/**
 * 再起動警告（黄）を送信する
 */
async function notifyDiscordRestartWarning(scheduleString) {
    const channel = await getChannel();
    if (!channel) return;

    const oldWarningId = readMessageId(warningMessageIdFile);
    await deleteMessage(oldWarningId, '古い警告通知');

    const embed = new EmbedBuilder()
        .setTitle('スケジュール再起動（予告）')
        .setDescription(`約1時間後にサーバーのスケジュール再起動が実行されます。\n(スケジュール時刻: \`${scheduleString}\`)`)
        .setColor(0xF1C40F)
        .addFields({ name: '通知時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>` });

    try {
        const msg = await channel.send({ content: '🔔 サーバー再起動 1時間前のお知らせ 🔔', embeds: [embed] });
        saveMessageId(msg.id, warningMessageIdFile);
        console.log(`[SCRIPT] Discordへの再起動警告通知に成功しました。(ID: ${msg.id})`);
    } catch (error) {
        console.error(`[SCRIPT] Discordへの再起動警告通知に失敗しました:`, error.message);
    }
}

/**
 * マイクラチャットをDiscordに送信する関数 (MC -> Discord)
 */
async function sendChatToDiscord(playerName, message) {
    const channel = await getChannel();
    if (!channel) return;

    const lowerPlayerName = playerName.toLowerCase();
    if (lowerPlayerName === 'server' || lowerPlayerName === 'discord') return;

    const cleanPlayerName = playerName.replace(/§[0-9a-fklmnor]/g, '');
    const cleanMessage = message
        .replace(/@everyone/g, '@​everyone')
        .replace(/@here/g, '@​here');

    let authorName = cleanPlayerName;
    let authorIcon = `https://minotar.net/avatar/${cleanPlayerName}/64.png`;

    if (Database && fs.existsSync(MARKET_DB_PATH)) {
        try {
            const db = new Database(MARKET_DB_PATH, { readonly: true });
            const link = db.prepare('SELECT discord_id, discord_name FROM discord_links WHERE minecraft_name=?').get(cleanPlayerName);
            db.close();
            if (link) {
                authorName = link.discord_name;
                try {
                    const guild = await discordClient.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(link.discord_id);
                    authorIcon = member.user.displayAvatarURL({ size: 64 });
                } catch {
                    authorIcon = `https://cdn.discordapp.com/embed/avatars/0.png`;
                }
            }
        } catch {}
    }

    const embed = new EmbedBuilder()
        .setAuthor({ name: authorName, iconURL: authorIcon })
        .setDescription(cleanMessage)
        .setColor(0x44FF44);

    try {
        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error(`[SCRIPT] Discordへのチャット転送に失敗しました (プレイヤー: ${cleanPlayerName}):`, error.message);
    }
}


// --- サーバー管理の関数 ---

/**
 * サーバーを起動する関数
 */
async function startServer() {
    console.log('[SCRIPT] サーバーを起動します...');

    // 起動時にクラッシュ関連状態をリセット
    isCrashLoopPaused = false;
    recentCrashTimestamps = [];
    isScheduledRestart = false;
    isManualStop = false;

    // クラッシュ通知・警告通知を削除
    const oldWarningId = readMessageId(warningMessageIdFile);
    if (oldWarningId) {
        await deleteMessage(oldWarningId, '古い警告通知');
        saveMessageId('', warningMessageIdFile);
    }
    const oldCrashId = readMessageId(crashMessageIdFile);
    if (oldCrashId) {
        await deleteMessage(oldCrashId, '古いクラッシュ通知');
        saveMessageId('', crashMessageIdFile);
    }

    // 起動中ステータスメッセージを送信
    await sendStartingStatus();

    e4mcIp = null;
    lineBuffer = '';

    serverProcess = spawn(serverCommand, serverArgs);
    serverReady = false;

    serverProcess.stdout.on('data', (data) => {
        const decodedData = iconv.decode(data, 'shiftjis');
        lineBuffer += decodedData;

        let lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const logLine of lines) {
            console.log(logLine);
            if (mcCaptureLines !== null) mcCaptureLines.push(logLine);
            pushLogLine(logLine);

            // 起動完了検出
            if (!serverReady && /INFO\].*Done \([\d.]+s\)!/.test(logLine)) {
                serverReady = true;
                console.log('[SCRIPT] サーバー起動完了を検出しました。');
                if (e4mcIp) sendToDiscord(e4mcIp); // 起動完了後に IP を通知
            }

            // オンラインプレイヤー追跡
            const joinMatch  = logLine.match(/INFO\]: (\S+) joined the game/);
            const leaveMatch = logLine.match(/INFO\]: (\S+) left the game/);
            if (joinMatch)  onlinePlayers.add(joinMatch[1]);
            if (leaveMatch) onlinePlayers.delete(leaveMatch[1]);

            if (!e4mcIp) {
                const match = logLine.match(e4mcRegex);
                if (match && match[1]) {
                    e4mcIp = match[1];
                    console.log('=======================================');
                    console.log(`[SCRIPT] e4mcのIPを取得しました: ${e4mcIp}`);
                    console.log('=======================================');
                    fs.writeFileSync('e4mc_ip.txt', e4mcIp, 'utf-8');
                    console.log('[SCRIPT] IPを e4mc_ip.txt に 保存しました。');
                    if (serverReady) sendToDiscord(e4mcIp); // 起動完了済みなら即通知
                }
            }
            const chatMatch = logLine.match(chatRegex);
            if (chatMatch && chatMatch[1] && chatMatch[2]) {
                sendChatToDiscord(chatMatch[1], chatMatch[2].trimEnd());
            }

            // DynamicMarketプラグインからの取引結果を受け取る
            const marketMatch = logLine.match(marketResultRegex);
            if (marketMatch) {
                const [, txId, status, message] = marketMatch;
                const pending = pendingMarketRequests.get(txId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingMarketRequests.delete(txId);
                    const isOk = status === 'OK';
                    const embed = new EmbedBuilder()
                        .setTitle(isOk ? '✅ 取引完了' : '❌ 取引失敗')
                        .setDescription(message)
                        .setColor(isOk ? 0x2ECC71 : 0xE74C3C);
                    pending.interaction.editReply({ embeds: [embed] }).catch(() => {});
                }
            }
        }
    });

    const stderrLogPath = 'logs/stderr_crash.log';
    const stderrStream = fs.createWriteStream(stderrLogPath, { flags: 'a' });
    stderrStream.write(`\n=== [${new Date().toISOString()}] 新セッション開始 ===\n`);

    serverProcess.stderr.on('data', (data) => {
        const decoded = iconv.decode(data, 'shiftjis');
        console.log(`[STDERR] ${decoded}`);
        stderrStream.write(decoded);
    });

    serverProcess.on('close', async (code) => {
        try {
            if (lineBuffer) console.log(lineBuffer);
            console.log(`[SCRIPT] サーバープロセスが終了しました (コード: ${code})`);
            serverProcess = null;
            serverReady = false;
            onlinePlayers.clear();

            // 起動中ステータスメッセージを常に削除する
            await deleteStatusMessage();

            const delayInSeconds = restartDelay || 10;

            if (isScheduledRestart) {
                // /restart コマンド またはスケジュール再起動 → そのまま再起動
                isScheduledRestart = false;

            } else if (isManualStop) {
                // 起動途中に /stop → 再起動しない
                isManualStop = false;
                console.log('[SCRIPT] 起動途中に手動停止されました。再起動を行いません。');
                const channel = await getChannel();
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🛑 サーバー停止完了')
                        .setDescription('起動途中に停止しました。`/start` コマンドで再起動できます。')
                        .setColor(0x95A5A6)
                        .addFields({ name: '停止時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>` });
                    channel.send({ embeds: [embed] }).catch(() => {});
                }
                return;

            } else if (code === 0) {
                // 正常終了 = ターミナルを閉じた / ゲーム内 stop / Discord /stop → 停止維持
                console.log('[SCRIPT] サーバーが正常終了しました（終了コード 0）。停止状態を維持します。');
                const channel = await getChannel();
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🛑 サーバー停止完了')
                        .setDescription('`/start` コマンドで再起動できます。')
                        .setColor(0x95A5A6)
                        .addFields({ name: '停止時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>` });
                    channel.send({ embeds: [embed] }).catch(() => {});
                }
                return;

            } else {
                // 異常終了（クラッシュ）→ 自動再起動
                console.warn(`[SCRIPT] サーバーが異常終了しました（終了コード ${code}）。自動的に再起動します...`);
                await notifyDiscordCrash();

                // クラッシュループ検知
                const now = Date.now();
                recentCrashTimestamps.push(now);
                recentCrashTimestamps = recentCrashTimestamps.filter(t => now - t < CRASH_LOOP_WINDOW_MS);

                if (recentCrashTimestamps.length >= CRASH_LOOP_LIMIT) {
                    console.error(`[SCRIPT] ⚠️  ${CRASH_LOOP_WINDOW_MS / 60000}分以内に${recentCrashTimestamps.length}回クラッシュしました。`);
                    console.error('[SCRIPT] クラッシュループを検知したため、自動再起動を停止します。');
                    console.error('[SCRIPT] logs/latest.log を確認してクラッシュ原因を特定してください。');
                    console.error('[SCRIPT] 修正後は /start コマンドで起動してください。');
                    isCrashLoopPaused = true;
                    return;
                }
            }

            console.log(`[SCRIPT] ${delayInSeconds}秒後にサーバーを再起動します。`);
            setTimeout(() => startServer(), delayInSeconds * 1000);

        } catch (e) {
            console.error('[SCRIPT FATAL ERROR] on(close) イベントの処理中に致命的なエラーが発生しました:', e);
        }
    });
}

/**
 * サーバーに 'stop' コマンドを送信して停止する関数
 */
function stopServer() {
    if (!serverProcess) return;
    isManualStop = true;
    if (serverReady) {
        console.log('[SCRIPT] サーバーに停止コマンドを送信します...');
        serverProcess.stdin.write('stop\n');
    } else {
        console.log('[SCRIPT] 起動中のため強制終了します...');
        serverProcess.kill();
    }
}

/**
 * 再起動スケジュールを設定する関数
 */
function calcWarningCron(restartCron, warningMinutes) {
    const parts = restartCron.split(' ');
    if (parts.length !== 5) return null;
    const [min, hour, dom, month, dow] = parts;
    const simpleMin  = /^\d+$/.test(min);
    const simpleHour = /^\d+$/.test(hour);
    if (!simpleMin || !simpleHour) return null;

    let total = parseInt(hour) * 60 + parseInt(min) - warningMinutes;
    let dayShift = 0;
    while (total < 0) { total += 1440; dayShift++; }

    const wMin  = total % 60;
    const wHour = Math.floor(total / 60);

    if (dayShift === 0) return `${wMin} ${wHour} ${dom} ${month} ${dow}`;
    if (/^\d+$/.test(dow)) {
        const wDow = (parseInt(dow) - dayShift + 70) % 7;
        return `${wMin} ${wHour} * * ${wDow}`;
    }
    if (dow === '*') return `${wMin} ${wHour} * * *`; // 毎日なら同じ毎日で前の時刻
    return null;
}

function warningToMinutes({ value, unit }) {
    const v = parseInt(value);
    switch (unit) {
        case 'minutes': return v;
        case 'hours':   return v * 60;
        case 'days':    return v * 1440;
        case 'months':  return v * 43200;
        default:        return v;
    }
}

function warningLabel({ value, unit }) {
    const units = { minutes:'分', hours:'時間', days:'日', months:'ヶ月' };
    return `${value}${units[unit] || unit}前`;
}

function setupRestartSchedule() {
    // 既存ジョブをすべてキャンセル
    for (const job of activeScheduleJobs) { try { job.cancel(); } catch {} }
    activeScheduleJobs = [];

    const config = loadScheduleConfig();
    console.log(`[SCRIPT] ${config.schedules.length}件の再起動スケジュールを設定します...`);

    for (const entry of config.schedules) {
        const cron = entry.cron;
        console.log(`[SCRIPT] 登録: [${cron}] ${entry.label || ''}`);

        // 警告ジョブ
        for (const w of (entry.warnings || [])) {
            const mins = warningToMinutes(w);
            const wCron = calcWarningCron(cron, mins);
            if (!wCron) continue;
            const label = warningLabel(w);
            console.log(`[SCRIPT]   警告 ${label}: [${wCron}]`);
            const wJob = schedule.scheduleJob(wCron, () => {
                notifyDiscordRestartWarning(cron);
                if (serverProcess) serverProcess.stdin.write(`say サーバーは約 ${label} にスケジュール再起動します。\n`);
            });
            if (wJob) activeScheduleJobs.push(wJob);
        }

        // 再起動ジョブ
        const rJob = schedule.scheduleJob(cron, () => {
            console.log(`[SCRIPT] ★ スケジュール再起動: ${entry.label || cron} ★`);
            if (isCrashLoopPaused) return;
            if (serverProcess) {
                isScheduledRestart = true;
                serverProcess.stdin.write('say サーバーは 10秒後 にスケジュール再起動します。\n');
                setTimeout(() => stopServer(), 10000);
            } else {
                startServer();
            }
        });
        if (rJob) activeScheduleJobs.push(rJob);
    }
}

// --- マーケットコマンドのハンドラ ---

/**
 * /market price, /market list
 * listings / transactions テーブルを直接読み取る（オフライン対応）
 */
async function handleMarketReadCommand(interaction, sub) {
    if (!Database) {
        return interaction.reply({
            content: '❌ `better-sqlite3` がインストールされていません。\nサーバー側で `npm install better-sqlite3` を実行してください。',
            ephemeral: true
        });
    }
    if (!fs.existsSync(MARKET_DB_PATH)) {
        return interaction.reply({
            content: '❌ マーケットDBが見つかりません。DynamicMarketプラグインを一度起動してください。',
            ephemeral: true
        });
    }

    let db;
    try {
        db = new Database(MARKET_DB_PATH, { readonly: true });

        if (sub === 'price') {
            const raw = interaction.options.getString('item').trim().toUpperCase().replace(/^MINECRAFT:/i, '');

            const stats = db.prepare(`
                SELECT COUNT(*) as cnt, AVG(price_per_unit) as avg_price,
                       MIN(price_per_unit) as min_price, MAX(price_per_unit) as max_price
                FROM transactions WHERE item_type=?
            `).get(raw);
            const last = db.prepare(
                `SELECT price_per_unit FROM transactions WHERE item_type=? ORDER BY sold_at DESC LIMIT 1`
            ).get(raw);
            const active = db.prepare(`
                SELECT COUNT(*) as cnt, MIN(price_per_unit) as cheapest, SUM(remaining_amount) as stock
                FROM listings WHERE item_type=? AND status='ACTIVE'
            `).get(raw);

            if ((!stats || stats.cnt === 0) && (!active || active.cnt === 0)) {
                return interaction.reply({
                    content: `❌ \`${raw}\` の取引履歴も出品も見つかりません。`,
                    ephemeral: true
                });
            }

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${raw}`)
                .setColor(0xF39C12);

            if (stats && stats.cnt > 0) {
                embed.addFields(
                    { name: '直近の成約価格', value: last ? `$${last.price_per_unit.toFixed(2)}` : '-', inline: true },
                    { name: '平均成約価格',   value: `$${stats.avg_price.toFixed(2)}`,  inline: true },
                    { name: '取引件数',       value: `${stats.cnt} 件`,                 inline: true },
                    { name: '最安値(取引)',   value: `$${stats.min_price.toFixed(2)}`,  inline: true },
                    { name: '最高値(取引)',   value: `$${stats.max_price.toFixed(2)}`,  inline: true },
                );
            }
            if (active && active.cnt > 0) {
                embed.addFields(
                    { name: '現在の出品数',   value: `${active.cnt} 件`,                        inline: true },
                    { name: '最安出品価格',   value: `$${active.cheapest.toFixed(2)}/個`,       inline: true },
                    { name: '在庫数',         value: `${active.stock} 個`,                      inline: true },
                );
            }
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'list') {
            const itemFilter = interaction.options.getString('item');
            const page       = (interaction.options.getInteger('page') || 1) - 1;
            const perPage    = 10;

            let listings, total;
            if (itemFilter) {
                const ft = itemFilter.trim().toUpperCase().replace(/^MINECRAFT:/i, '');
                listings = db.prepare(
                    `SELECT * FROM listings WHERE status='ACTIVE' AND item_type LIKE ?
                     ORDER BY price_per_unit ASC LIMIT ? OFFSET ?`
                ).all(`%${ft}%`, perPage, page * perPage);
                total = db.prepare(
                    `SELECT COUNT(*) as c FROM listings WHERE status='ACTIVE' AND item_type LIKE ?`
                ).get(`%${ft}%`).c;
            } else {
                listings = db.prepare(
                    `SELECT * FROM listings WHERE status='ACTIVE'
                     ORDER BY item_type ASC, price_per_unit ASC LIMIT ? OFFSET ?`
                ).all(perPage, page * perPage);
                total = db.prepare(
                    `SELECT COUNT(*) as c FROM listings WHERE status='ACTIVE'`
                ).get().c;
            }

            const totalPages = Math.max(1, Math.ceil(total / perPage));
            const safePage   = Math.max(0, Math.min(page, totalPages - 1));

            const lines = listings.map(row => {
                const ts = `<t:${Math.floor(row.listed_at / 1000)}:R>`;
                return `**ID:${row.id}** \`${row.item_type}\` — $${row.price_per_unit.toFixed(2)}/個 × ${row.remaining_amount}個\n出品者: ${row.seller_name} (${ts})`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`🏪 出品一覧 (${safePage + 1}/${totalPages})`)
                .setDescription(lines.length > 0 ? lines.join('\n\n') : '出品がありません。')
                .setColor(0x3498DB)
                .setFooter({ text: `総出品: ${total} 件 | /market list [item] [page]` });
            return interaction.reply({ embeds: [embed] });
        }

    } catch (err) {
        console.error('[MARKET] DB読み取りエラー:', err);
        return interaction.reply({ content: '❌ データベース読み取り中にエラーが発生しました。', ephemeral: true });
    } finally {
        if (db) db.close();
    }
}

/**
 * /market buy
 * サーバーの stdin に `market mkt-discord <txId> buy <player> <listingId> <qty>` を送り、
 * stdout の [MARKET_RESULT] 行で結果を受け取る。
 */
async function handleLinkCommand(interaction) {
    if (!Database) {
        return interaction.reply({ content: '❌ better-sqlite3 が読み込まれていません。', ephemeral: true });
    }
    // DBファイルがなくても open すれば新規作成される
    const db = new Database(MARKET_DB_PATH);
    try {
        db.pragma('journal_mode = WAL');
        // 既存DBに discord_name 列がなければ追加
        try { db.exec("ALTER TABLE discord_links ADD COLUMN discord_name TEXT NOT NULL DEFAULT ''"); } catch {}
        db.exec(`
            CREATE TABLE IF NOT EXISTS link_codes (
                code TEXT PRIMARY KEY,
                discord_id TEXT NOT NULL,
                discord_name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS discord_links (
                discord_id TEXT PRIMARY KEY,
                discord_name TEXT NOT NULL DEFAULT '',
                minecraft_uuid TEXT NOT NULL,
                minecraft_name TEXT NOT NULL,
                linked_at INTEGER NOT NULL
            );
        `);
        // 既に連携済みか確認
        const existing = db.prepare('SELECT minecraft_name FROM discord_links WHERE discord_id=?')
                           .get(interaction.user.id);
        if (existing) {
            return interaction.reply({
                content: `✅ 既に **${existing.minecraft_name}** と連携済みです。`,
                ephemeral: true
            });
        }

        // 同一DiscordユーザーのコードとDBを整理（有効期限切れ含む）
        db.prepare('DELETE FROM link_codes WHERE discord_id=? OR created_at<?')
          .run(interaction.user.id, Date.now() - 10 * 60 * 1000);

        // 6桁英数字コードを生成
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        db.prepare('INSERT INTO link_codes (code,discord_id,discord_name,created_at) VALUES (?,?,?,?)')
          .run(code, interaction.user.id, interaction.user.tag, Date.now());

        return interaction.reply({
            content: `🔗 Minecraftで以下のコマンドを実行してください（**10分以内**）:\n\`/mclink ${code}\``,
            ephemeral: true
        });
    } finally {
        db.close();
    }
}

async function handleMarketTradeCommand(interaction) {
    // 連携チェック
    if (!Database || !fs.existsSync(MARKET_DB_PATH)) {
        return interaction.reply({ content: '❌ マーケットDBが見つかりません。', ephemeral: true });
    }
    const dbCheck = new Database(MARKET_DB_PATH, { readonly: true });
    let minecraftName;
    try {
        const link = dbCheck.prepare('SELECT minecraft_name FROM discord_links WHERE discord_id=?')
                            .get(interaction.user.id);
        if (!link) {
            return interaction.reply({
                content: '❌ Minecraftアカウントが連携されていません。\n`/link` コマンドでコードを取得してMinecraftで実行してください。',
                ephemeral: true
            });
        }
        minecraftName = link.minecraft_name;
    } finally {
        dbCheck.close();
    }

    const listingId = interaction.options.getInteger('id');
    const qty       = interaction.options.getInteger('qty') || 0; // 0 = 全量
    const txId      = crypto.randomUUID().replace(/-/g, '');

    const timer = setTimeout(() => {
        if (pendingMarketRequests.has(txId)) {
            pendingMarketRequests.delete(txId);
            interaction.editReply({ content: '❌ タイムアウト: サーバーからの応答がありませんでした。' }).catch(() => {});
        }
    }, 30000);

    pendingMarketRequests.set(txId, { interaction, timer });

    await interaction.deferReply();
    serverProcess.stdin.write(`market mkt-discord ${txId} buy ${minecraftName} ${listingId} ${qty}\n`);
}

// --- MCコマンド出力キャプチャ ---

function captureOutput(cmd, timeoutMs) {
    return new Promise(resolve => {
        mcCaptureLines = [];
        serverProcess.stdin.write(cmd + '\n');
        setTimeout(() => {
            const captured = mcCaptureLines;
            mcCaptureLines = null;
            resolve(captured);
        }, timeoutMs);
    });
}

function formatCapturedOutput(lines) {
    const cleaned = lines
        .map(l => {
            // stdout形式: [HH:MM:SS INFO]: message
            const m = l.match(/^\[[\d:]+\s+\w+\]: (.+)/);
            return m ? m[1].trimEnd() : null;
        })
        .filter(l => l !== null)
        .filter(l => !l.startsWith('<'))              // チャット除外
        .filter(l => !l.startsWith('[MARKET_RESULT]')) // マーケット結果除外
        .filter(l => !l.startsWith('[LINK]'))          // 連携ログ除外
        .filter(l => l.trim().length > 0);

    if (cleaned.length === 0) return '✅ 実行しました';

    const hasError = cleaned.some(l =>
        /unknown command|not found|error|invalid|no player|failed/i.test(l)
    );

    const icon = hasError ? '❌' : '✅';
    return `${icon}\n\`\`\`\n${cleaned.join('\n').slice(0, 1800)}\n\`\`\``;
}

// --- DB管理コマンド ---

async function handleDbCommand(interaction) {
    if (!Database || !fs.existsSync(MARKET_DB_PATH)) {
        return interaction.reply({ content: '❌ DBが見つかりません。', ephemeral: true });
    }
    // 既存DBにcolumnがなければ追加（マイグレーション）
    { const _db = new Database(MARKET_DB_PATH); try { _db.exec("ALTER TABLE discord_links ADD COLUMN discord_name TEXT NOT NULL DEFAULT ''"); } catch {} finally { _db.close(); } }
    const sub = interaction.options.getSubcommand();
    switch (sub) {
        case 'links':    return handleDbLinks(interaction);
        case 'unlink':   return handleDbUnlink(interaction);
        case 'listings': return handleDbListings(interaction);
        case 'cancel':   return handleDbCancel(interaction);
        case 'history':  return handleDbHistory(interaction);
    }
}

async function handleDbLinks(interaction) {
    const db = new Database(MARKET_DB_PATH, { readonly: true });
    try {
        const rows = db.prepare(
            'SELECT discord_name, minecraft_name, linked_at FROM discord_links ORDER BY linked_at DESC'
        ).all();
        if (rows.length === 0) {
            return interaction.reply({ content: '連携データがありません。', ephemeral: true });
        }
        const lines = rows.map(r => {
            const date = new Date(r.linked_at).toLocaleDateString('ja-JP');
            return `**${r.minecraft_name}** ↔ ${r.discord_name}（${date}）`;
        });
        const embed = new EmbedBuilder()
            .setTitle('🔗 Discord連携一覧')
            .setDescription(lines.join('\n'))
            .setColor(0x5865F2)
            .setFooter({ text: `${rows.length}件` });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    } finally {
        db.close();
    }
}

async function handleDbUnlink(interaction) {
    const target = interaction.options.getString('target');
    const db = new Database(MARKET_DB_PATH);
    try {
        let result = db.prepare('DELETE FROM discord_links WHERE minecraft_name=?').run(target);
        if (result.changes === 0) {
            result = db.prepare('DELETE FROM discord_links WHERE discord_name=?').run(target);
        }
        if (result.changes === 0) {
            const idMatch = target.match(/\d{15,}/);
            if (idMatch) result = db.prepare('DELETE FROM discord_links WHERE discord_id=?').run(idMatch[0]);
        }
        if (result.changes > 0) {
            return interaction.reply({ content: `✅ **${target}** の連携を解除しました。`, ephemeral: true });
        } else {
            return interaction.reply({ content: `❌ **${target}** の連携データが見つかりません。`, ephemeral: true });
        }
    } finally {
        db.close();
    }
}

async function handleDbListings(interaction) {
    const item = interaction.options.getString('item');
    const db = new Database(MARKET_DB_PATH, { readonly: true });
    try {
        const rows = item
            ? db.prepare("SELECT * FROM listings WHERE status='ACTIVE' AND item_type LIKE ? ORDER BY listed_at DESC LIMIT 20")
                 .all(`%${item.toUpperCase()}%`)
            : db.prepare("SELECT * FROM listings WHERE status='ACTIVE' ORDER BY listed_at DESC LIMIT 20").all();
        if (rows.length === 0) {
            return interaction.reply({ content: 'アクティブな出品がありません。', ephemeral: true });
        }
        const lines = rows.map(r =>
            `\`ID:${r.id}\` **${r.item_type}** x${r.remaining_amount} ＠${r.price_per_unit} | ${r.seller_name}`
        );
        const embed = new EmbedBuilder()
            .setTitle('📦 出品一覧（ACTIVE）')
            .setDescription(lines.join('\n'))
            .setColor(0xE67E22)
            .setFooter({ text: `${rows.length}件（最大20件）` });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    } finally {
        db.close();
    }
}

async function handleDbCancel(interaction) {
    const id = interaction.options.getInteger('id');
    const db = new Database(MARKET_DB_PATH);
    try {
        const listing = db.prepare("SELECT * FROM listings WHERE id=? AND status='ACTIVE'").get(id);
        if (!listing) {
            return interaction.reply({ content: `❌ 出品ID **${id}** が見つかりません（終了済みの可能性あり）。`, ephemeral: true });
        }
        db.prepare("UPDATE listings SET status='CANCELLED' WHERE id=?").run(id);
        return interaction.reply({
            content: `✅ 出品ID **${id}** をキャンセルしました。\n> ${listing.item_type} x${listing.remaining_amount} | 出品者: ${listing.seller_name}\n⚠️ アイテムは自動返却されません。必要なら手動で渡してください。`,
            ephemeral: true
        });
    } finally {
        db.close();
    }
}

async function handleDbHistory(interaction) {
    const player = interaction.options.getString('player');
    const db = new Database(MARKET_DB_PATH, { readonly: true });
    try {
        const rows = player
            ? db.prepare(
                'SELECT t.*, l.seller_name FROM transactions t LEFT JOIN listings l ON t.listing_id=l.id ' +
                'WHERE t.buyer_name=? ORDER BY t.sold_at DESC LIMIT 20'
              ).all(player)
            : db.prepare(
                'SELECT t.*, l.seller_name FROM transactions t LEFT JOIN listings l ON t.listing_id=l.id ' +
                'ORDER BY t.sold_at DESC LIMIT 20'
              ).all();
        if (rows.length === 0) {
            return interaction.reply({ content: '取引データがありません。', ephemeral: true });
        }
        const lines = rows.map(r => {
            const date = new Date(r.sold_at).toLocaleDateString('ja-JP');
            return `${date} **${r.item_type}** x${r.amount} ＠${r.price_per_unit} | ${r.buyer_name} → ${r.seller_name ?? '不明'}`;
        });
        const embed = new EmbedBuilder()
            .setTitle(`📊 取引履歴${player ? `（${player}）` : ''}`)
            .setDescription(lines.join('\n'))
            .setColor(0x2ECC71)
            .setFooter({ text: `${rows.length}件（最大20件）` });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    } finally {
        db.close();
    }
}

// --- メイン処理 ---
// Botのログイン後に clientReady で setupRestartSchedule() が呼ばれる。
// MCサーバーは /start コマンドで起動するまで停止状態を維持する。

// 管理パネル起動
startAdminPanel({
    port:              parseInt(process.env.ADMIN_PORT) || 4000,
    serverPath:        __dirname,
    getProcess:        () => serverProcess,
    getOnlinePlayers:  () => [...onlinePlayers],
    getDiscordClient:  () => discordClient,
    clientId:          clientId,
    clientSecret:      process.env.DISCORD_CLIENT_SECRET || '',
    panelUrl:          process.env.ADMIN_PANEL_URL || 'http://localhost:4000',
    adminRoleId:       adminRoleId,
    dbPath:            MARKET_DB_PATH,
    schedulePath:      SCHEDULE_CONFIG_PATH,
    reloadSchedule:    setupRestartSchedule,
    onStart:    () => { isCrashLoopPaused = false; startServer(); },
    onStop:     () => { isScheduledRestart = false; stopServer(); },
    onRestart:  () => {
        if (serverProcess) {
            isScheduledRestart = true;
            isCrashLoopPaused = false;
            serverProcess.stdin.write('say サーバーは 10秒後 に再起動します。\n');
            setTimeout(() => stopServer(), 10000);
        } else {
            isCrashLoopPaused = false;
            startServer();
        }
    },
});
