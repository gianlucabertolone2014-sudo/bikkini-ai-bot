require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require('discord.js');
const Groq = require('groq-sdk');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ════════════════════════════════════════════════════════════════════════════
// DATA FILES
// ════════════════════════════════════════════════════════════════════════════
const SETTINGS_FILE = './member_settings.json';
const ADMIN_SETTINGS_FILE = './admin_settings.json';
const OFFENSES_FILE = './offenses.json';
const STATS_FILE = './stats.json';
const VIP_LEAKER_CODES_FILE = './vip_leaker_codes.json';
const UPDATES_FILE = './updates.json';

const conversations = new Map();
const pendingPings = new Map();
const pendingModSelections = new Map();

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function defaultAdminSettings() {
  return {
    aiOnline: true,
    accessPassword: '5362',
    modPermissions: { ban: false, kick: false, timeout: false, mute: false },
    timeoutDurationMinutes: 60,
    strikeThreshold: 3,
    blockedWords: [],
    logChannelId: null,
    restrictedChannelIds: [],
    trustedRoleIds: []
  };
}

function loadAdminSettings() {
  const data = loadJSON(ADMIN_SETTINGS_FILE, defaultAdminSettings());
  const defaults = defaultAdminSettings();
  for (const key of Object.keys(defaults)) {
    if (data[key] === undefined) data[key] = defaults[key];
  }
  return data;
}
function saveAdminSettings(data) { saveJSON(ADMIN_SETTINGS_FILE, data); }

function loadSettings() { return loadJSON(SETTINGS_FILE, {}); }
function saveSettings(data) { saveJSON(SETTINGS_FILE, data); }
function getUserLanguage(userId) { return loadSettings()[userId]?.language || null; }
function setUserLanguage(userId, language) {
  const settings = loadSettings();
  if (!settings[userId]) settings[userId] = {};
  settings[userId].language = language;
  saveSettings(settings);
}

function loadOffenses() { return loadJSON(OFFENSES_FILE, {}); }
function saveOffenses(data) { saveJSON(OFFENSES_FILE, data); }
function addOffense(userId) {
  const offenses = loadOffenses();
  offenses[userId] = (offenses[userId] || 0) + 1;
  saveOffenses(offenses);
  return offenses[userId];
}
function resetOffenses(userId) {
  const offenses = loadOffenses();
  delete offenses[userId];
  saveOffenses(offenses);
}

function loadStats() { return loadJSON(STATS_FILE, { totalRequests: 0, userRequests: {} }); }
function saveStats(data) { saveJSON(STATS_FILE, data); }
function trackUsage(userId) {
  const stats = loadStats();
  stats.totalRequests = (stats.totalRequests || 0) + 1;
  stats.userRequests[userId] = (stats.userRequests[userId] || 0) + 1;
  saveStats(stats);
}

// ════════════════════════════════════════════════════════════════════════════
// VIP Leaker: weekly free code claim
// ════════════════════════════════════════════════════════════════════════════
function loadVIPLeakerClaims() { return loadJSON(VIP_LEAKER_CODES_FILE, {}); }
function saveVIPLeakerClaims(data) { saveJSON(VIP_LEAKER_CODES_FILE, data); }

function generateGiftCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getNextClaimTime(lastClaimISO) {
  const last = new Date(lastClaimISO).getTime();
  return last + 7 * 24 * 60 * 60 * 1000; // 7 days
}

// ════════════════════════════════════════════════════════════════════════════
// VIP Leaker: early access updates
// ════════════════════════════════════════════════════════════════════════════
function loadUpdates() { return loadJSON(UPDATES_FILE, []); }
function saveUpdates(data) { saveJSON(UPDATES_FILE, data); }
function addUpdate(title, content, authorId) {
  const updates = loadUpdates();
  updates.unshift({ title, content, authorId, postedAt: new Date().toISOString() });
  if (updates.length > 25) updates.length = 25;
  saveUpdates(updates);
}

// ════════════════════════════════════════════════════════════════════════════
// PERMISSIONS
// ════════════════════════════════════════════════════════════════════════════
function isAdmin(member) {
  const envAdmins = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
  const memberId = member.id || member.user?.id;
  if (envAdmins.includes(memberId)) return true;

  const settings = loadAdminSettings();
  if (settings.trustedRoleIds.length === 0) return false;

  const roles = member.roles?.cache;
  if (!roles) return false;
  return settings.trustedRoleIds.some(roleId => roles.has(roleId));
}

function isVIP(member) {
  if (!process.env.VIP_ROLE_ID) return false;
  const roles = member.roles?.cache;
  if (!roles) return false;
  return roles.has(process.env.VIP_ROLE_ID) || isAdmin(member);
}

function isVIPLeaker(member) {
  if (!process.env.VIP_LEAKER_ROLE_ID) return false;
  const roles = member.roles?.cache;
  if (!roles) return false;
  return roles.has(process.env.VIP_LEAKER_ROLE_ID) || isAdmin(member);
}

// ════════════════════════════════════════════════════════════════════════════
// BLOCKED WORDS
// ════════════════════════════════════════════════════════════════════════════
const DEFAULT_BLOCKED_WORDS = [
  'nigga', 'nigger', 'fag', 'faggot', 'retard', 'cunt', 'whore',
  'nazi', 'hitler', 'kys', 'kill yourself',
  'hure', 'hurensohn', 'wichser', 'spast', 'mongo',
  'fuck you', 'motherfucker', 'mother fucker', 'fuck u', 'fucker',
  'asshole', 'dumbass', 'bastard', 'piece of shit', 'son of a bitch'
];

function getAllBlockedWords() {
  const settings = loadAdminSettings();
  return [...DEFAULT_BLOCKED_WORDS, ...settings.blockedWords];
}
function containsOffensiveLanguage(text) {
  const lower = text.toLowerCase();
  return getAllBlockedWords().some(word => lower.includes(word));
}

// ════════════════════════════════════════════════════════════════════════════
// MOD ACTIONS / PING DETECTION
// ════════════════════════════════════════════════════════════════════════════
const MOD_ACTION_WORDS = ['ban', 'kick', 'timeout', 'mute', 'unban', 'unmute'];
const PING_WORDS = ['everyone', 'here', '@everyone', '@here'];
const ACTION_TO_PERMISSION = { ban: 'ban', kick: 'kick', timeout: 'timeout', mute: 'mute', unban: 'ban', unmute: 'mute' };

function getModAction(text) {
  const lower = text.toLowerCase();
  for (const action of MOD_ACTION_WORDS) {
    if (lower.startsWith(action + ' ') || lower === action) return action;
  }
  return null;
}
function containsPingWord(text) { return PING_WORDS.some(word => text.toLowerCase().includes(word)); }
function extractPingType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('everyone')) return 'everyone';
  if (lower.includes('here')) return 'here';
  return null;
}
function extractUserId(text) {
  const match = text.match(/<@!?(\d+)>/);
  return match ? match[1] : null;
}

// ════════════════════════════════════════════════════════════════════════════
// LOGGING
// ════════════════════════════════════════════════════════════════════════════
async function logAction(guild, description, color) {
  const settings = loadAdminSettings();
  if (!settings.logChannelId) return;
  try {
    const channel = await guild.channels.fetch(settings.logChannelId);
    if (channel) {
      await channel.send({ embeds: [new EmbedBuilder().setColor(color || 0x3498db).setDescription(description).setTimestamp()] });
    }
  } catch (err) {
    console.error('[LOG ERROR]', err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MOD ACTION EXECUTION
// ════════════════════════════════════════════════════════════════════════════
async function executeModAction(context, action, targetId, reason) {
  const guild = context.guild;
  const send = (content) => context.channel ? context.channel.send(content) : context.followUp(content);
  const settings = loadAdminSettings();

  try {
    const member = await guild.members.fetch(targetId);
    if (action === 'ban') {
      await member.ban({ reason });
      await logAction(guild, `🔨 <@${targetId}> was **banned**.\nReason: ${reason}`, 0xe74c3c);
      return send(`✅ <@${targetId}> has been **banned**.\n**Reason:** ${reason}`);
    }
    if (action === 'kick') {
      await member.kick(reason);
      await logAction(guild, `👋 <@${targetId}> was **kicked**.\nReason: ${reason}`, 0xe67e22);
      return send(`✅ <@${targetId}> has been **kicked**.\n**Reason:** ${reason}`);
    }
    if (action === 'timeout' || action === 'mute') {
      await member.timeout(settings.timeoutDurationMinutes * 60 * 1000, reason);
      await logAction(guild, `🔇 <@${targetId}> was **timed out** for ${settings.timeoutDurationMinutes} minutes.\nReason: ${reason}`, 0xf1c40f);
      return send(`✅ <@${targetId}> has been **timed out for ${settings.timeoutDurationMinutes} minutes**.\n**Reason:** ${reason}`);
    }
    if (action === 'unban') {
      await guild.members.unban(targetId, reason);
      await logAction(guild, `🔓 <@${targetId}> was **unbanned**.`, 0x2ecc71);
      return send(`✅ <@${targetId}> has been **unbanned**.`);
    }
    if (action === 'unmute') {
      await member.timeout(null);
      await logAction(guild, `🔊 <@${targetId}> was **unmuted**.`, 0x2ecc71);
      return send(`✅ <@${targetId}> has been **unmuted**.`);
    }
  } catch (err) {
    console.error('[MOD ACTION ERROR]', err);
    return send('❌ Could not perform this action. Check my permissions and role position.');
  }
}

const SYSTEM_PROMPT_BASE = `You are Bikkini AI, a cool and helpful Discord bot assistant.
Your name is Bikkini AI. You are friendly, helpful, and a little funny sometimes.
Keep responses concise and to the point - this is Discord, not an essay.`;

// ════════════════════════════════════════════════════════════════════════════
// /ai HANDLER
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// VIP Coding Mode - exclusive Roblox Studio / Lua coding help
// ════════════════════════════════════════════════════════════════════════════
const VIP_CODING_PROMPT = `You are Bikkini AI in VIP Coding Mode, an expert Roblox Studio and Lua/Luau scripting assistant.
You give precise, high-quality, production-ready code for Roblox Studio.
Always use proper Luau syntax, follow Roblox best practices (e.g. using RemoteEvents correctly, avoiding exploits, using :Connect() properly, proper service usage like game:GetService()).
When giving code, wrap it in \`\`\`lua code blocks.
Explain briefly what the script does after the code.
Be thorough and accurate - this is a premium feature for VIP members, so give your best possible answer.`;

async function handleVIPCoding(message, prompt) {
  if (!prompt) {
    return message.reply('👑 **VIP Coding Mode** — Ask me anything about Roblox Studio scripting!\nExample: `?ai vip how do I make a leaderboard with DataStore?`');
  }

  await message.channel.sendTyping();

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: VIP_CODING_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2048,
      temperature: 0.3
    });

    const reply = response.choices[0].message.content;
    const safeReply = reply.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');

    const header = '👑 **VIP Coding Mode**\n\n';
    const full = header + safeReply;

    if (full.length <= 1900) {
      await message.reply({ content: full, allowedMentions: { parse: ['users'] } });
    } else {
      await message.reply({ content: header, allowedMentions: { parse: [] } });
      const chunks = safeReply.match(/.{1,1900}/gs);
      for (const chunk of chunks) await message.channel.send({ content: chunk, allowedMentions: { parse: ['users'] } });
    }
  } catch (err) {
    console.error('[VIP CODING ERROR]', err);
    await message.reply('❌ Something went wrong. Please try again.');
  }
}

async function handleAI(message, prompt) {
  const adminSettings = loadAdminSettings();
  const userIsAdmin = isAdmin(message.member);
  const userIsVIP = isVIP(message.member);

  // VIPs can still use the AI even when it's turned off for everyone else
  if (!adminSettings.aiOnline && !userIsVIP) {
    return message.reply({ content: '🔴 Bikkini AI is currently offline (turned off by an Admin). 👑 VIP members can still use it.', allowedMentions: { parse: [] } });
  }

  if (adminSettings.restrictedChannelIds.length > 0 && !adminSettings.restrictedChannelIds.includes(message.channel.id) && !userIsAdmin) {
    return message.reply({ content: '❌ Bikkini AI cannot be used in this channel.', allowedMentions: { parse: [] } });
  }

  if (prompt.trim().toLowerCase() === 'confirm') {
    if (!userIsAdmin) return message.reply({ content: '❌ Only admins can confirm pings.', allowedMentions: { parse: [] } });

    const pending = pendingPings.get(message.channel.id);
    if (!pending) return message.reply('❌ There is no pending ping to confirm in this channel.');

    const mention = pending.pingType === 'everyone' ? '@everyone' : '@here';
    pendingPings.delete(message.channel.id);
    await logAction(message.guild, `📢 <@${message.author.id}> confirmed a **${mention}** ping.`, 0x3498db);

    return message.channel.send({ content: `${mention} ${pending.content}`, allowedMentions: { parse: ['everyone'] } });
  }

  if (!prompt) {
    return message.reply('❓ Please write something after `?ai` — for example: `?ai how are you?`');
  }

  // VIP exclusive coding mode: ?ai vip <question>
  if (prompt.toLowerCase().startsWith('vip ')) {
    if (!userIsVIP) {
      return message.reply({ content: '👑 The `?ai vip` coding mode is exclusive to VIP members.', allowedMentions: { parse: [] } });
    }
    return await handleVIPCoding(message, prompt.slice(4).trim());
  }

  if (containsOffensiveLanguage(prompt)) {
    const offenseCount = addOffense(message.author.id);

    if (offenseCount >= adminSettings.strikeThreshold) {
      try {
        await message.member.ban({ reason: `Used offensive language with ?ai ${adminSettings.strikeThreshold} times` });
        await logAction(message.guild, `🔨 <@${message.author.id}> was **auto-banned** after reaching ${adminSettings.strikeThreshold} offensive language strikes.`, 0xe74c3c);
        return message.reply({ content: `🔨 **${message.author.tag}** has been **banned** for repeatedly using offensive language (strike ${offenseCount}/${adminSettings.strikeThreshold}).`, allowedMentions: { parse: [] } });
      } catch (err) {
        console.error('[BAN ERROR]', err);
        return message.reply({ content: '❌ Tried to ban you for repeated offenses but could not (check my permissions).', allowedMentions: { parse: [] } });
      }
    }

    try { await message.member.timeout(adminSettings.timeoutDurationMinutes * 60 * 1000, 'Used offensive language with ?ai'); } catch {}
    await logAction(message.guild, `⚠️ <@${message.author.id}> received strike ${offenseCount}/${adminSettings.strikeThreshold} for offensive language.`, 0xf1c40f);
    return message.reply({
      content: `🔇 You have been timed out for ${adminSettings.timeoutDurationMinutes} minutes for using offensive language. **Warning ${offenseCount}/${adminSettings.strikeThreshold}** — reaching the limit results in a ban.`,
      allowedMentions: { parse: [] }
    });
  }

  if (containsPingWord(prompt)) {
    const pingType = extractPingType(prompt);
    if (!userIsAdmin) return message.reply({ content: '⚠️ You need a confirmation from an Admin to do this.', allowedMentions: { parse: [] } });

    const pingContent = prompt.replace(/@?everyone/gi, '').replace(/@?here/gi, '').trim();
    pendingPings.set(message.channel.id, { pingType, content: pingContent, requestedBy: message.author.id });

    return message.reply({
      content: `⏳ Wait for an Admin to confirm to ping @${pingType}. An admin can type \`?ai confirm\` to send it.`,
      allowedMentions: { parse: [] }
    });
  }

  const modAction = getModAction(prompt);
  if (modAction) {
    if (!userIsAdmin) return message.reply({ content: '⚠️ You need a confirmation from an Admin to do this.', allowedMentions: { parse: [] } });

    const permKey = ACTION_TO_PERMISSION[modAction];
    if (!adminSettings.modPermissions[permKey]) {
      return message.reply(`⚠️ The **${modAction}** command is currently **disabled**. Enable it with \`?ai adminsettings\`.`);
    }

    const rest = prompt.slice(modAction.length).trim();
    const targetId = extractUserId(rest);

    if (targetId) {
      const reason = rest.replace(/<@!?\d+>/, '').trim() || `Action requested via Bikkini AI by ${message.author.tag}`;
      return await executeModAction(message, modAction, targetId, reason);
    }

    pendingModSelections.set(message.author.id, { action: modAction, reason: rest || `Action requested via Bikkini AI by ${message.author.tag}` });
    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId('modaction_userselect').setPlaceholder(`Select a user to ${modAction}`)
    );
    return message.reply({ content: `Select the user you want to **${modAction}**:`, components: [row] });
  }

  trackUsage(message.author.id);
  const userId = message.author.id;
  await message.channel.sendTyping();

  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: prompt });
  if (history.length > 10) history.splice(0, history.length - 10);

  const userLanguage = getUserLanguage(userId);
  let systemPrompt = SYSTEM_PROMPT_BASE;
  systemPrompt += userLanguage
    ? `\nIMPORTANT: This user has set their preferred language to "${userLanguage}". ALWAYS respond in that language.`
    : `\nVERY IMPORTANT: Always detect the language the user is writing in and respond in that EXACT same language.`;

  // VIPs get a faster, smaller model for quicker responses
  const modelToUse = userIsVIP ? 'llama-3.1-8b-instant' : 'llama-3.3-70b-versatile';

  try {
    const response = await groq.chat.completions.create({
      model: modelToUse,
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      max_tokens: 1024
    });

    const reply = response.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    const safeReply = (userIsVIP ? '⚡ ' : '') + reply.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');

    if (safeReply.length <= 1900) {
      await message.reply({ content: safeReply, allowedMentions: { parse: ['users'] } });
    } else {
      const chunks = safeReply.match(/.{1,1900}/gs);
      for (const chunk of chunks) await message.channel.send({ content: chunk, allowedMentions: { parse: ['users'] } });
    }
  } catch (err) {
    console.error('[AI ERROR]', err);
    await message.reply('❌ Something went wrong. Please try again.');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// /membersettings
// ════════════════════════════════════════════════════════════════════════════
async function handleMemberSettings(message) {
  const current = getUserLanguage(message.author.id);
  const offenses = loadOffenses()[message.author.id] || 0;
  const threshold = loadAdminSettings().strikeThreshold;

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('⚙️ Member Settings')
    .setDescription(`**Language:** ${current || 'Auto-detect'}\n**Your strikes:** ${offenses}/${threshold}\n\nUse the menu below to manage your settings.`);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('membersettings_menu')
      .setPlaceholder('Choose a setting')
      .addOptions([
        { label: 'Set Language', description: 'Set a fixed language for AI responses', value: 'set_language', emoji: '🌐' },
        { label: 'Reset Language', description: 'Go back to auto-detect', value: 'reset_language', emoji: '🔄' }
      ])
  );

  await message.reply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
// /adminsettings
// ════════════════════════════════════════════════════════════════════════════
async function buildAdminSettingsPanel() {
  const settings = loadAdminSettings();
  const mp = settings.modPermissions;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🛠️ Admin Settings')
    .addFields(
      { name: 'AI Status', value: settings.aiOnline ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'Timeout Duration', value: `${settings.timeoutDurationMinutes} min`, inline: true },
      { name: 'Strike Threshold', value: `${settings.strikeThreshold} strikes`, inline: true },
      { name: 'Ban', value: mp.ban ? '✅' : '❌', inline: true },
      { name: 'Kick', value: mp.kick ? '✅' : '❌', inline: true },
      { name: 'Timeout', value: mp.timeout ? '✅' : '❌', inline: true },
      { name: 'Mute', value: mp.mute ? '✅' : '❌', inline: true },
      { name: 'Log Channel', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'Not set', inline: true },
      { name: 'Restricted Channels', value: settings.restrictedChannelIds.length ? settings.restrictedChannelIds.map(id => `<#${id}>`).join(', ') : 'None (all allowed)', inline: false },
      { name: 'Trusted Roles', value: settings.trustedRoleIds.length ? settings.trustedRoleIds.map(id => `<@&${id}>`).join(', ') : 'None', inline: false },
      { name: 'Custom Blocked Words', value: settings.blockedWords.length ? settings.blockedWords.join(', ') : 'None', inline: false }
    )
    .setDescription('Use the menu below to change settings.');

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('adminsettings_menu')
      .setPlaceholder('Choose a setting to change')
      .addOptions([
        { label: 'AI: Online', value: 'ai_online', emoji: '🟢' },
        { label: 'AI: Offline', value: 'ai_offline', emoji: '🔴' },
        { label: 'Ban: Enable', value: 'ban_on', emoji: '✅' },
        { label: 'Ban: Disable', value: 'ban_off', emoji: '❌' },
        { label: 'Kick: Enable', value: 'kick_on', emoji: '✅' },
        { label: 'Kick: Disable', value: 'kick_off', emoji: '❌' },
        { label: 'Timeout: Enable', value: 'timeout_on', emoji: '✅' },
        { label: 'Timeout: Disable', value: 'timeout_off', emoji: '❌' },
        { label: 'Mute: Enable', value: 'mute_on', emoji: '✅' },
        { label: 'Mute: Disable', value: 'mute_off', emoji: '❌' },
        { label: 'Set Timeout Duration', value: 'set_timeout_duration', emoji: '⏱️' },
        { label: 'Set Strike Threshold', value: 'set_strike_threshold', emoji: '🎯' },
        { label: 'Add Blocked Word', value: 'add_blocked_word', emoji: '🚫' },
        { label: 'Remove Blocked Word', value: 'remove_blocked_word', emoji: '🗑️' },
        { label: 'Set Log Channel', value: 'set_log_channel', emoji: '📝' },
        { label: 'Disable Logging', value: 'disable_logging', emoji: '🔕' },
        { label: 'Restrict to Channels', value: 'set_restricted_channels', emoji: '🔒' },
        { label: 'Allow All Channels', value: 'clear_restricted_channels', emoji: '🔓' },
        { label: 'Add Trusted Role', value: 'add_trusted_role', emoji: '👮' },
        { label: 'Clear Trusted Roles', value: 'clear_trusted_roles', emoji: '🧹' },
        { label: 'View Stats', value: 'view_stats', emoji: '📊' },
        { label: 'Reset a User\'s Strikes', value: 'reset_user_strikes', emoji: '🔄' },
        { label: 'Change Access Password', value: 'change_password', emoji: '🔑' }
      ])
  );

  return { embeds: [embed], components: [row] };
}

// ─── handleAdminSettings: requires password before showing panel ─────────────
async function handleAdminSettings(message) {
  if (!isAdmin(message.member)) {
    return message.reply({ content: '❌ Only admins can use this command.', allowedMentions: { parse: [] } });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adminsettings_unlock').setLabel('🔒 Enter Password to Get Access').setStyle(ButtonStyle.Primary)
  );

  await message.reply({
    embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle('🔒 Admin Access Required').setDescription('Click the button below and enter the password to access Admin Settings.')],
    components: [row]
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Other text commands
// ════════════════════════════════════════════════════════════════════════════
function handleHelp(message) {
  message.reply([
    '**🤖 Bikkini AI – Commands**', '',
    '`?ai <question>` – Ask Bikkini AI anything',
    '`?ai vip <question>` – 👑 VIP-exclusive Roblox Studio coding help',
    '`?ai claimcode` – 👑 VIP Leaker: claim your weekly free VIP gift code',
    '`?ai updates` – 👑 VIP Leaker: view early access updates',
    '`?ai membersettings` – Manage your personal settings',
    '`?ai languagepanel` – Quick language selector',
    '`?ai adminsettings` – Admin controls (Admin only)',
    '`?ai modpanel` – Quick moderation panel (Admin only)',
    '`?ai statspanel` – Server stats panel (Admin only)',
    '`?ai userpanel @user` – View/manage a specific user (Admin only)',
    '`?ai securitypanel` – Security settings panel (Admin only)',
    '`?reset` – Reset your conversation history',
    '`?help` – Show this help menu',
    '`?info` – Info about Bikkini AI'
  ].join('\n'));
}
function handleInfo(message) {
  message.reply([
    '**🌊 Bikkini AI**', '',
    '> I am Bikkini AI, your intelligent Discord assistant!',
    '> I understand and respond in **every language**.', '',
    `**Server:** ${message.guild.name}`,
    `**Powered by:** Groq AI (Llama 3)`,
    `**Prefix:** \`?\``
  ].join('\n'));
}
function handleReset(message) {
  conversations.delete(message.author.id);
  message.reply('🔄 Your conversation history has been reset!');
}

// ════════════════════════════════════════════════════════════════════════════
// Message Router
// ════════════════════════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('?')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'ai') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'membersettings') return await handleMemberSettings(message);
    if (sub === 'adminsettings') return await handleAdminSettings(message);
    if (sub === 'modpanel') return await handleModPanel(message);
    if (sub === 'statspanel') return await handleStatsPanel(message);
    if (sub === 'userpanel') return await handleUserPanel(message, args.slice(1).join(' '));
    if (sub === 'languagepanel') return await handleLanguagePanel(message);
    if (sub === 'securitypanel') return await handleSecurityPanel(message);
    if (sub === 'claimcode') return await handleClaimCode(message);
    if (sub === 'updates') return await handleUpdates(message);
    if (sub === 'postupdate') return await handlePostUpdate(message, args.slice(1).join(' '));
    return await handleAI(message, args.join(' '));
  }

  switch (command) {
    case 'help': handleHelp(message); break;
    case 'info': handleInfo(message); break;
    case 'reset': handleReset(message); break;
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Interactions
// ════════════════════════════════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {

  // ── Admin Settings: Password Unlock Button ────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'adminsettings_unlock') {
    if (!isAdmin(interaction.member)) {
      return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId('adminsettings_password_modal').setTitle('🔒 Admin Access');
    const input = new TextInputBuilder()
      .setCustomId('password_input')
      .setLabel('Enter Password for Access')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Enter password...')
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return await interaction.showModal(modal);
  }

  // ── Admin Settings: Password Check ─────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'adminsettings_password_modal') {
    if (!isAdmin(interaction.member)) {
      return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });
    }

    const password = interaction.fields.getTextInputValue('password_input').trim();
    const currentSettings = loadAdminSettings();
    if (password !== currentSettings.accessPassword) {
      return await interaction.reply({ content: '❌ Incorrect password.', ephemeral: true });
    }

    const panel = await buildAdminSettingsPanel();
    return await interaction.reply({ ...panel, ephemeral: true });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'membersettings_menu') {
    const choice = interaction.values[0];

    if (choice === 'reset_language') {
      const settings = loadSettings();
      if (settings[interaction.user.id]) delete settings[interaction.user.id].language;
      saveSettings(settings);
      return await interaction.reply({ content: '✅ Language reset to auto-detect!', ephemeral: true });
    }

    if (choice === 'set_language') {
      const modal = new ModalBuilder().setCustomId('language_modal').setTitle('Set Your Language');
      const input = new TextInputBuilder().setCustomId('language_input').setLabel('Language / Country').setStyle(TextInputStyle.Short).setPlaceholder('e.g. German, Spanish, Turkish...').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'adminsettings_menu') {
    if (!isAdmin(interaction.member)) return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });

    const choice = interaction.values[0];
    const settings = loadAdminSettings();

    const simpleToggles = {
      ai_online: () => { settings.aiOnline = true; return '🟢 Bikkini AI is now **online**.'; },
      ai_offline: () => { settings.aiOnline = false; return '🔴 Bikkini AI is now **offline**.'; },
      ban_on: () => { settings.modPermissions.ban = true; return '✅ **Ban** command enabled.'; },
      ban_off: () => { settings.modPermissions.ban = false; return '❌ **Ban** command disabled.'; },
      kick_on: () => { settings.modPermissions.kick = true; return '✅ **Kick** command enabled.'; },
      kick_off: () => { settings.modPermissions.kick = false; return '❌ **Kick** command disabled.'; },
      timeout_on: () => { settings.modPermissions.timeout = true; return '✅ **Timeout** command enabled.'; },
      timeout_off: () => { settings.modPermissions.timeout = false; return '❌ **Timeout** command disabled.'; },
      mute_on: () => { settings.modPermissions.mute = true; return '✅ **Mute** command enabled.'; },
      mute_off: () => { settings.modPermissions.mute = false; return '❌ **Mute** command disabled.'; },
      disable_logging: () => { settings.logChannelId = null; return '🔕 Logging disabled.'; },
      clear_restricted_channels: () => { settings.restrictedChannelIds = []; return '🔓 Bikkini AI can now be used in all channels.'; },
      clear_trusted_roles: () => { settings.trustedRoleIds = []; return '🧹 Trusted roles cleared.'; }
    };

    if (simpleToggles[choice]) {
      const msg = simpleToggles[choice]();
      saveAdminSettings(settings);
      return await interaction.reply({ content: msg, ephemeral: true });
    }

    if (choice === 'set_timeout_duration') {
      const modal = new ModalBuilder().setCustomId('admin_timeout_modal').setTitle('Set Timeout Duration');
      const input = new TextInputBuilder().setCustomId('timeout_minutes').setLabel('Duration in minutes').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 60').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (choice === 'set_strike_threshold') {
      const modal = new ModalBuilder().setCustomId('admin_strikes_modal').setTitle('Set Strike Threshold');
      const input = new TextInputBuilder().setCustomId('strike_count').setLabel('Number of strikes before ban').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 3').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (choice === 'add_blocked_word') {
      const modal = new ModalBuilder().setCustomId('admin_addword_modal').setTitle('Add Blocked Word');
      const input = new TextInputBuilder().setCustomId('word_input').setLabel('Word or phrase to block').setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (choice === 'remove_blocked_word') {
      if (settings.blockedWords.length === 0) {
        return await interaction.reply({ content: '❌ There are no custom blocked words to remove.', ephemeral: true });
      }
      const modal = new ModalBuilder().setCustomId('admin_removeword_modal').setTitle('Remove Blocked Word');
      const input = new TextInputBuilder().setCustomId('word_input').setLabel('Word to remove').setStyle(TextInputStyle.Short).setPlaceholder(settings.blockedWords.join(', ')).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (choice === 'set_log_channel') {
      const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('admin_logchannel_select').setPlaceholder('Select a log channel'));
      return await interaction.reply({ content: 'Select the channel for mod-action logs:', components: [row], ephemeral: true });
    }

    if (choice === 'set_restricted_channels') {
      const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('admin_restrictchannel_select').setPlaceholder('Select allowed channels').setMinValues(1).setMaxValues(10));
      return await interaction.reply({ content: 'Select the channels where `?ai` is allowed:', components: [row], ephemeral: true });
    }

    if (choice === 'add_trusted_role') {
      const row = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('admin_trustedrole_select').setPlaceholder('Select a trusted role'));
      return await interaction.reply({ content: 'Select a role that should be treated as Admin by Bikkini AI:', components: [row], ephemeral: true });
    }

    if (choice === 'view_stats') {
      const stats = loadStats();
      const topUsers = Object.entries(stats.userRequests || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, count], i) => `${i + 1}. <@${id}> — ${count} requests`).join('\n') || 'No data yet.';

      const offenses = loadOffenses();
      const topOffenders = Object.entries(offenses)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, count], i) => `${i + 1}. <@${id}> — ${count} strikes`).join('\n') || 'No strikes recorded.';

      return await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('📊 Bikkini AI Stats')
          .addFields(
            { name: 'Total Requests', value: `${stats.totalRequests || 0}`, inline: true },
            { name: 'Top Users', value: topUsers, inline: false },
            { name: 'Top Offenders (Strikes)', value: topOffenders, inline: false }
          )],
        ephemeral: true
      });
    }

    if (choice === 'reset_user_strikes') {
      const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('admin_resetstrikes_select').setPlaceholder('Select a user to reset strikes'));
      return await interaction.reply({ content: 'Select the user whose strikes you want to reset:', components: [row], ephemeral: true });
    }

    if (choice === 'change_password') {
      const modal = new ModalBuilder().setCustomId('admin_changepassword_modal').setTitle('Change Access Password');
      const input = new TextInputBuilder()
        .setCustomId('new_password_input')
        .setLabel('New Password')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter new password...')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === 'admin_changepassword_modal') {
    if (!isAdmin(interaction.member)) {
      return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });
    }
    const newPassword = interaction.fields.getTextInputValue('new_password_input').trim();
    if (!newPassword) {
      return await interaction.reply({ content: '❌ Password cannot be empty.', ephemeral: true });
    }
    const settings = loadAdminSettings();
    settings.accessPassword = newPassword;
    saveAdminSettings(settings);
    return await interaction.reply({ content: '✅ Admin access password has been changed successfully.', ephemeral: true });
  }

  if (interaction.isModalSubmit() && interaction.customId === 'language_modal') {    const language = interaction.fields.getTextInputValue('language_input');
    setUserLanguage(interaction.user.id, language);
    return await interaction.reply({ content: `✅ Your language has been set to **${language}**!`, ephemeral: true });
  }

  if (interaction.isModalSubmit() && interaction.customId === 'admin_timeout_modal') {
    const minutes = parseInt(interaction.fields.getTextInputValue('timeout_minutes'));
    if (isNaN(minutes) || minutes < 1) return await interaction.reply({ content: '❌ Please enter a valid number of minutes.', ephemeral: true });
    const settings = loadAdminSettings();
    settings.timeoutDurationMinutes = minutes;
    saveAdminSettings(settings);
    return await interaction.reply({ content: `✅ Timeout duration set to **${minutes} minutes**.`, ephemeral: true });
  }

  if (interaction.isModalSubmit() && interaction.customId === 'admin_strikes_modal') {
    const count = parseInt(interaction.fields.getTextInputValue('strike_count'));
    if (isNaN(count) || count < 1) return await interaction.reply({ content: '❌ Please enter a valid number.', ephemeral: true });
    const settings = loadAdminSettings();
    settings.strikeThreshold = count;
    saveAdminSettings(settings);
    return await interaction.reply({ content: `✅ Strike threshold set to **${count}**.`, ephemeral: true });
  }

  if (interaction.isModalSubmit() && interaction.customId === 'admin_addword_modal') {
    const word = interaction.fields.getTextInputValue('word_input').toLowerCase().trim();
    const settings = loadAdminSettings();
    if (!settings.blockedWords.includes(word)) settings.blockedWords.push(word);
    saveAdminSettings(settings);
    return await interaction.reply({ content: `✅ Added **"${word}"** to the blocked words list.`, ephemeral: true });
  }

  if (interaction.isModalSubmit() && interaction.customId === 'admin_removeword_modal') {
    const word = interaction.fields.getTextInputValue('word_input').toLowerCase().trim();
    const settings = loadAdminSettings();
    settings.blockedWords = settings.blockedWords.filter(w => w !== word);
    saveAdminSettings(settings);
    return await interaction.reply({ content: `✅ Removed **"${word}"** from the blocked words list (if it existed).`, ephemeral: true });
  }

  if (interaction.isChannelSelectMenu() && interaction.customId === 'admin_logchannel_select') {
    const settings = loadAdminSettings();
    settings.logChannelId = interaction.values[0];
    saveAdminSettings(settings);
    return await interaction.reply({ content: `✅ Log channel set to <#${interaction.values[0]}>.`, ephemeral: true });
  }

  if (interaction.isChannelSelectMenu() && interaction.customId === 'admin_restrictchannel_select') {
    const settings = loadAdminSettings();
    settings.restrictedChannelIds = interaction.values;
    saveAdminSettings(settings);
    return await interaction.reply({ content: `✅ Bikkini AI is now restricted to: ${interaction.values.map(id => `<#${id}>`).join(', ')}`, ephemeral: true });
  }

  if (interaction.isRoleSelectMenu() && interaction.customId === 'admin_trustedrole_select') {
    const settings = loadAdminSettings();
    const roleId = interaction.values[0];
    if (!settings.trustedRoleIds.includes(roleId)) settings.trustedRoleIds.push(roleId);
    saveAdminSettings(settings);
    return await interaction.reply({ content: `✅ <@&${roleId}> is now treated as Admin by Bikkini AI.`, ephemeral: true });
  }

  if (interaction.isUserSelectMenu() && interaction.customId === 'admin_resetstrikes_select') {
    const targetId = interaction.values[0];
    resetOffenses(targetId);
    return await interaction.reply({ content: `✅ Strikes for <@${targetId}> have been reset.`, ephemeral: true });
  }

  if (interaction.isUserSelectMenu() && interaction.customId === 'modaction_userselect') {
    const pending = pendingModSelections.get(interaction.user.id);
    if (!pending) return await interaction.reply({ content: '❌ This request has expired.', ephemeral: true });

    const targetId = interaction.values[0];
    pendingModSelections.delete(interaction.user.id);

    await interaction.update({ content: `Processing **${pending.action}** on <@${targetId}>...`, components: [] });
    await executeModAction(interaction, pending.action, targetId, pending.reason);
  }

  // ── /modpanel: action chosen, now show user select ────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'modpanel_action_select') {
    if (!isAdmin(interaction.member)) return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });

    const action = interaction.values[0];
    const settings = loadAdminSettings();
    const permKey = ACTION_TO_PERMISSION[action];

    if (settings.modPermissions[permKey] === false && action !== 'unban' && action !== 'unmute') {
      return await interaction.reply({ content: `⚠️ The **${action}** command is currently disabled in \`?ai adminsettings\`.`, ephemeral: true });
    }

    pendingModSelections.set(interaction.user.id, { action, reason: `Action requested via Bikkini AI Mod Panel by ${interaction.user.tag}` });

    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId('modaction_userselect').setPlaceholder(`Select a user to ${action}`)
    );
    return await interaction.update({ content: `Select the user you want to **${action}**:`, embeds: [], components: [row] });
  }

  // ── /statspanel buttons ─────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'statspanel_topusers') {
    const stats = loadStats();
    const topUsers = Object.entries(stats.userRequests || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, count], i) => `${i + 1}. <@${id}> — ${count} requests`).join('\n') || 'No data yet.';
    return await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('🏆 Top Users').setDescription(topUsers)], ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId === 'statspanel_topoffenders') {
    const offenses = loadOffenses();
    const topOffenders = Object.entries(offenses)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, count], i) => `${i + 1}. <@${id}> — ${count} strikes`).join('\n') || 'No strikes recorded.';
    return await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('⚠️ Top Offenders').setDescription(topOffenders)], ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId === 'statspanel_overview') {
    const stats = loadStats();
    const offenses = loadOffenses();
    const totalStrikes = Object.values(offenses).reduce((a, b) => a + b, 0);
    return await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('📈 Server Activity')
        .addFields(
          { name: 'Total AI Requests', value: `${stats.totalRequests || 0}`, inline: true },
          { name: 'Unique Users', value: `${Object.keys(stats.userRequests || {}).length}`, inline: true },
          { name: 'Total Strikes Issued', value: `${totalStrikes}`, inline: true }
        )],
      ephemeral: true
    });
  }

  // ── /userpanel: select user, then show panel ────────────────────────────────
  if (interaction.isUserSelectMenu() && interaction.customId === 'userpanel_select') {
    if (!isAdmin(interaction.member)) return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });
    const targetId = interaction.values[0];
    const panel = await buildUserPanelEmbed(interaction.guild, targetId);
    return await interaction.update({ content: null, ...panel });
  }

  // ── /userpanel buttons ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('userpanel_resetstrikes_')) {
    const targetId = interaction.customId.split('_')[2];
    resetOffenses(targetId);
    const panel = await buildUserPanelEmbed(interaction.guild, targetId);
    return await interaction.update(panel);
  }

  if (interaction.isButton() && interaction.customId.startsWith('userpanel_ban_')) {
    const targetId = interaction.customId.split('_')[2];
    await interaction.update({ content: `Processing ban on <@${targetId}>...`, embeds: [], components: [] });
    await executeModAction(interaction, 'ban', targetId, `Banned via User Panel by ${interaction.user.tag}`);
  }

  if (interaction.isButton() && interaction.customId.startsWith('userpanel_timeout_')) {
    const targetId = interaction.customId.split('_')[2];
    await interaction.update({ content: `Processing timeout on <@${targetId}>...`, embeds: [], components: [] });
    await executeModAction(interaction, 'timeout', targetId, `Timed out via User Panel by ${interaction.user.tag}`);
  }

  // ── /languagepanel select ────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'languagepanel_select') {
    const choice = interaction.values[0];

    if (choice === 'reset') {
      const settings = loadSettings();
      if (settings[interaction.user.id]) delete settings[interaction.user.id].language;
      saveSettings(settings);
      return await interaction.reply({ content: '✅ Language reset to auto-detect!', ephemeral: true });
    }

    if (choice === 'custom') {
      const modal = new ModalBuilder().setCustomId('language_modal').setTitle('Set Custom Language');
      const input = new TextInputBuilder().setCustomId('language_input').setLabel('Language / Country').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Dutch, Korean...').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    setUserLanguage(interaction.user.id, choice);
    return await interaction.reply({ content: `✅ Your language has been set to **${choice}**!`, ephemeral: true });
  }

  // ── /securitypanel menu ──────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'securitypanel_menu') {
    if (!isAdmin(interaction.member)) return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });

    const choice = interaction.values[0];
    const settings = loadAdminSettings();

    if (choice === 'add_word') {
      const modal = new ModalBuilder().setCustomId('admin_addword_modal').setTitle('Add Blocked Word');
      const input = new TextInputBuilder().setCustomId('word_input').setLabel('Word or phrase to block').setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (choice === 'remove_word') {
      if (settings.blockedWords.length === 0) return await interaction.reply({ content: '❌ No custom blocked words to remove.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId('admin_removeword_modal').setTitle('Remove Blocked Word');
      const input = new TextInputBuilder().setCustomId('word_input').setLabel('Word to remove').setStyle(TextInputStyle.Short).setPlaceholder(settings.blockedWords.join(', ')).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (choice === 'add_role') {
      const row = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('admin_trustedrole_select').setPlaceholder('Select a trusted role'));
      return await interaction.reply({ content: 'Select a role to trust as Admin:', components: [row], ephemeral: true });
    }

    if (choice === 'clear_roles') {
      settings.trustedRoleIds = [];
      saveAdminSettings(settings);
      return await interaction.reply({ content: '🧹 Trusted roles cleared.', ephemeral: true });
    }
  }
});

client.once('ready', () => {
  console.log(`✅ Bikkini AI is online as: ${client.user.tag}`);
  client.user.setActivity('?ai | Bikkini AI', { type: 3 });
});

// ════════════════════════════════════════════════════════════════════════════
// /modpanel - quick mod actions without typing commands
// ════════════════════════════════════════════════════════════════════════════
async function handleModPanel(message) {
  if (!isAdmin(message.member)) {
    return message.reply({ content: '❌ Only admins can use this command.', allowedMentions: { parse: [] } });
  }

  const settings = loadAdminSettings();
  const mp = settings.modPermissions;

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🔨 Moderation Panel')
    .setDescription('Pick an action below, then select the user to apply it to.')
    .addFields(
      { name: 'Ban', value: mp.ban ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: 'Kick', value: mp.kick ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: 'Timeout/Mute', value: (mp.timeout || mp.mute) ? '✅ Enabled' : '❌ Disabled', inline: true }
    );

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('modpanel_action_select')
      .setPlaceholder('Choose an action')
      .addOptions([
        { label: 'Ban', value: 'ban', emoji: '🔨' },
        { label: 'Kick', value: 'kick', emoji: '👋' },
        { label: 'Timeout', value: 'timeout', emoji: '🔇' },
        { label: 'Mute', value: 'mute', emoji: '🔇' },
        { label: 'Unban', value: 'unban', emoji: '🔓' },
        { label: 'Unmute', value: 'unmute', emoji: '🔊' }
      ])
  );

  await message.reply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
// /statspanel - clickable stats overview
// ════════════════════════════════════════════════════════════════════════════
async function handleStatsPanel(message) {
  if (!isAdmin(message.member)) {
    return message.reply({ content: '❌ Only admins can use this command.', allowedMentions: { parse: [] } });
  }

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📊 Stats Panel')
    .setDescription('Click a button below to view different stats.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('statspanel_topusers').setLabel('Top Users').setStyle(ButtonStyle.Primary).setEmoji('🏆'),
    new ButtonBuilder().setCustomId('statspanel_topoffenders').setLabel('Top Offenders').setStyle(ButtonStyle.Danger).setEmoji('⚠️'),
    new ButtonBuilder().setCustomId('statspanel_overview').setLabel('Server Activity').setStyle(ButtonStyle.Secondary).setEmoji('📈')
  );

  await message.reply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
// /userpanel @user - view & manage a single user
// ════════════════════════════════════════════════════════════════════════════
async function buildUserPanelEmbed(guild, targetId) {
  const offenses = loadOffenses()[targetId] || 0;
  const threshold = loadAdminSettings().strikeThreshold;
  const stats = loadStats();
  const requests = stats.userRequests?.[targetId] || 0;
  const language = getUserLanguage(targetId);

  let memberTag = `<@${targetId}>`;
  try {
    const member = await guild.members.fetch(targetId);
    memberTag = member.user.tag;
  } catch {}

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`👥 User Panel — ${memberTag}`)
    .addFields(
      { name: 'User', value: `<@${targetId}>`, inline: true },
      { name: 'Strikes', value: `${offenses}/${threshold}`, inline: true },
      { name: 'AI Requests', value: `${requests}`, inline: true },
      { name: 'Language', value: language || 'Auto-detect', inline: true }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`userpanel_resetstrikes_${targetId}`).setLabel('Reset Strikes').setStyle(ButtonStyle.Success).setEmoji('🔄'),
    new ButtonBuilder().setCustomId(`userpanel_ban_${targetId}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
    new ButtonBuilder().setCustomId(`userpanel_timeout_${targetId}`).setLabel('Timeout').setStyle(ButtonStyle.Secondary).setEmoji('🔇')
  );

  return { embeds: [embed], components: [row] };
}

async function handleUserPanel(message, argText) {
  if (!isAdmin(message.member)) {
    return message.reply({ content: '❌ Only admins can use this command.', allowedMentions: { parse: [] } });
  }

  const targetId = extractUserId(argText);
  if (!targetId) {
    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId('userpanel_select').setPlaceholder('Select a user to view')
    );
    return message.reply({ content: 'Select the user you want to view:', components: [row] });
  }

  const panel = await buildUserPanelEmbed(message.guild, targetId);
  await message.reply(panel);
}

// ════════════════════════════════════════════════════════════════════════════
// /languagepanel - quick language dropdown instead of typing
// ════════════════════════════════════════════════════════════════════════════
async function handleLanguagePanel(message) {
  const current = getUserLanguage(message.author.id);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🌍 Language Panel')
    .setDescription(`Current: **${current || 'Auto-detect'}**\n\nPick a language below, or use Custom for anything else.`);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('languagepanel_select')
      .setPlaceholder('Choose a language')
      .addOptions([
        { label: 'English', value: 'English', emoji: '🇬🇧' },
        { label: 'German', value: 'German', emoji: '🇩🇪' },
        { label: 'Turkish', value: 'Turkish', emoji: '🇹🇷' },
        { label: 'Spanish', value: 'Spanish', emoji: '🇪🇸' },
        { label: 'French', value: 'French', emoji: '🇫🇷' },
        { label: 'Italian', value: 'Italian', emoji: '🇮🇹' },
        { label: 'Portuguese', value: 'Portuguese', emoji: '🇵🇹' },
        { label: 'Arabic', value: 'Arabic', emoji: '🇸🇦' },
        { label: 'Russian', value: 'Russian', emoji: '🇷🇺' },
        { label: 'Auto-detect (Reset)', value: 'reset', emoji: '🔄' },
        { label: 'Custom (type your own)', value: 'custom', emoji: '✏️' }
      ])
  );

  await message.reply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
// /securitypanel - security-only settings, separate from the rest
// ════════════════════════════════════════════════════════════════════════════
async function handleSecurityPanel(message) {
  if (!isAdmin(message.member)) {
    return message.reply({ content: '❌ Only admins can use this command.', allowedMentions: { parse: [] } });
  }

  const settings = loadAdminSettings();

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🔒 Security Panel')
    .addFields(
      { name: 'Custom Blocked Words', value: settings.blockedWords.length ? settings.blockedWords.join(', ') : 'None', inline: false },
      { name: 'Trusted Roles', value: settings.trustedRoleIds.length ? settings.trustedRoleIds.map(id => `<@&${id}>`).join(', ') : 'None', inline: false }
    );

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('securitypanel_menu')
      .setPlaceholder('Choose a security setting')
      .addOptions([
        { label: 'Add Blocked Word', value: 'add_word', emoji: '🚫' },
        { label: 'Remove Blocked Word', value: 'remove_word', emoji: '🗑️' },
        { label: 'Add Trusted Role', value: 'add_role', emoji: '👮' },
        { label: 'Clear Trusted Roles', value: 'clear_roles', emoji: '🧹' }
      ])
  );

  await message.reply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
// /ai claimcode - VIP Leaker weekly free VIP code
// ════════════════════════════════════════════════════════════════════════════
async function handleClaimCode(message) {
  if (!isVIPLeaker(message.member)) {
    return message.reply({ content: '👑 This command is exclusive to **VIP Leaker** members.', allowedMentions: { parse: [] } });
  }

  const claims = loadVIPLeakerClaims();
  const userId = message.author.id;
  const lastClaim = claims[userId]?.lastClaimedAt;

  if (lastClaim) {
    const nextClaimTime = getNextClaimTime(lastClaim);
    if (Date.now() < nextClaimTime) {
      const remaining = nextClaimTime - Date.now();
      const days = Math.floor(remaining / 86400000);
      const hours = Math.floor((remaining % 86400000) / 3600000);
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('⏳ Already Claimed')
          .setDescription(`You already claimed your free VIP code this week.\n\nYou can claim a new one in **${days}d ${hours}h**.`)],
        allowedMentions: { parse: [] }
      });
    }
  }

  const code = generateGiftCode();
  claims[userId] = { lastClaimedAt: new Date().toISOString(), lastCode: code };
  saveVIPLeakerClaims(claims);

  await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('🎁 Your Weekly VIP Code')
      .setDescription(`Here is your free VIP gift code! Give it to anyone you want to give VIP.\n\n\`\`\`${code}\`\`\``)
      .setFooter({ text: 'You can claim a new one again in 7 days.' })
      .setTimestamp()],
    allowedMentions: { parse: [] }
  });

  console.log(`[VIP LEAKER] ${message.author.tag} claimed weekly gift code: ${code}`);
}

// ════════════════════════════════════════════════════════════════════════════
// /ai updates - VIP Leaker early access updates
// ════════════════════════════════════════════════════════════════════════════
async function handleUpdates(message) {
  if (!isVIPLeaker(message.member)) {
    return message.reply({ content: '👑 Early access updates are exclusive to **VIP Leaker** members.', allowedMentions: { parse: [] } });
  }

  const updates = loadUpdates();
  if (updates.length === 0) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('📢 Early Access Updates').setDescription('No updates posted yet. Check back soon!')] });
  }

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📢 Early Access Updates')
    .setFooter({ text: '👑 Exclusive to VIP Leaker members' });

  for (const update of updates.slice(0, 5)) {
    embed.addFields({
      name: `${update.title} — <t:${Math.floor(new Date(update.postedAt).getTime() / 1000)}:R>`,
      value: update.content
    });
  }

  await message.reply({ embeds: [embed] });
}

// ════════════════════════════════════════════════════════════════════════════
// /ai postupdate - Admin posts a new early access update
// ════════════════════════════════════════════════════════════════════════════
async function handlePostUpdate(message, argText) {
  if (!isAdmin(message.member)) {
    return message.reply({ content: '❌ Only admins can post updates.', allowedMentions: { parse: [] } });
  }

  if (!argText) {
    return message.reply('Usage: `?ai postupdate Title | Content goes here`');
  }

  const [title, ...rest] = argText.split('|');
  const content = rest.join('|').trim();

  if (!content) {
    return message.reply('Usage: `?ai postupdate Title | Content goes here` (separate title and content with `|`)');
  }

  addUpdate(title.trim(), content, message.author.id);

  await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Update Posted')
      .setDescription(`Posted to VIP Leaker early access feed:\n\n**${title.trim()}**\n${content}`)]
  });
}

client.login(process.env.DISCORD_TOKEN);
