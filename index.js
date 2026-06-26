require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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

const conversations = new Map();
const SETTINGS_FILE = './member_settings.json';
const ADMIN_SETTINGS_FILE = './admin_settings.json';
// Pending ping confirmations: channelId -> { pingType, content, requestedBy }
const pendingPings = new Map();
// Pending mod action waiting for user select: userId -> { action }
const pendingModSelections = new Map();

// ─── Member Settings ────────────────────────────────────────────────────────────
function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}
function saveSettings(data) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2)); }
function getUserLanguage(userId) { return loadSettings()[userId]?.language || null; }
function setUserLanguage(userId, language) {
  const settings = loadSettings();
  if (!settings[userId]) settings[userId] = {};
  settings[userId].language = language;
  saveSettings(settings);
}

// ─── Admin Settings ─────────────────────────────────────────────────────────────
function loadAdminSettings() {
  if (!fs.existsSync(ADMIN_SETTINGS_FILE)) {
    return { aiOnline: true, modPermissions: { ban: false, kick: false, timeout: false, mute: false } };
  }
  const data = JSON.parse(fs.readFileSync(ADMIN_SETTINGS_FILE, 'utf8'));
  if (!data.modPermissions) data.modPermissions = { ban: false, kick: false, timeout: false, mute: false };
  return data;
}
function saveAdminSettings(data) { fs.writeFileSync(ADMIN_SETTINGS_FILE, JSON.stringify(data, null, 2)); }
function isAdmin(userId) {
  return process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()).includes(userId) : false;
}

// ─── Blocked words ───────────────────────────────────────────────────────────────
const BLOCKED_WORDS = [
  'nigga', 'nigger', 'fag', 'faggot', 'retard', 'cunt', 'whore',
  'nazi', 'hitler', 'kys', 'kill yourself',
  'hure', 'hurensohn', 'wichser', 'spast', 'mongo',
  'fuck you', 'motherfucker', 'mother fucker', 'fuck u', 'fucker',
  'asshole', 'dumbass', 'bastard', 'piece of shit', 'son of a bitch'
];
function containsOffensiveLanguage(text) {
  return BLOCKED_WORDS.some(word => text.toLowerCase().includes(word));
}

const MOD_ACTION_WORDS = ['ban', 'kick', 'timeout', 'mute', 'unban', 'unmute'];
const PING_WORDS = ['everyone', 'here', '@everyone', '@here'];

function getModAction(text) {
  const lower = text.toLowerCase();
  for (const action of MOD_ACTION_WORDS) {
    if (lower.startsWith(action + ' ') || lower === action) return action;
  }
  return null;
}
function containsPingWord(text) {
  return PING_WORDS.some(word => text.toLowerCase().includes(word));
}
function extractPingType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('everyone')) return 'everyone';
  if (lower.includes('here')) return 'here';
  return null;
}

const SYSTEM_PROMPT_BASE = `You are Bikkini AI, a cool and helpful Discord bot assistant.
Your name is Bikkini AI. You are friendly, helpful, and a little funny sometimes.
Keep responses concise and to the point - this is Discord, not an essay.`;

function extractUserId(text) {
  const match = text.match(/<@!?(\d+)>/);
  return match ? match[1] : null;
}

const ACTION_TO_PERMISSION = { ban: 'ban', kick: 'kick', timeout: 'timeout', mute: 'mute', unban: 'ban', unmute: 'mute' };

async function executeModAction(context, action, targetId, reason) {
  const guild = context.guild;
  const send = (content) => context.channel ? context.channel.send(content) : context.followUp(content);

  try {
    const member = await guild.members.fetch(targetId);
    switch (action) {
      case 'ban':
        await member.ban({ reason });
        return send(`✅ <@${targetId}> has been **banned**.\n**Reason:** ${reason}`);
      case 'kick':
        await member.kick(reason);
        return send(`✅ <@${targetId}> has been **kicked**.\n**Reason:** ${reason}`);
      case 'timeout':
      case 'mute':
        await member.timeout(60 * 60 * 1000, reason);
        return send(`✅ <@${targetId}> has been **timed out for 1 hour**.\n**Reason:** ${reason}`);
      case 'unban':
        await guild.members.unban(targetId, reason);
        return send(`✅ <@${targetId}> has been **unbanned**.`);
      case 'unmute':
        await member.timeout(null);
        return send(`✅ <@${targetId}> has been **unmuted**.`);
    }
  } catch (err) {
    console.error('[MOD ACTION ERROR]', err);
    return send('❌ Could not perform this action. Check my permissions and role position.');
  }
}

// ─── /ai Handler ───────────────────────────────────────────────────────────────
async function handleAI(message, prompt) {
  const adminSettings = loadAdminSettings();

  if (!adminSettings.aiOnline) {
    return message.reply({ content: '🔴 Bikkini AI is currently offline (turned off by an Admin).', allowedMentions: { parse: [] } });
  }

  // ?ai confirm - admin confirms a pending ping
  if (prompt.trim().toLowerCase() === 'confirm') {
    if (!isAdmin(message.author.id)) {
      return message.reply({ content: '❌ Only admins can confirm pings.', allowedMentions: { parse: [] } });
    }

    const pending = pendingPings.get(message.channel.id);
    if (!pending) {
      return message.reply('❌ There is no pending ping to confirm in this channel.');
    }

    const mention = pending.pingType === 'everyone' ? '@everyone' : '@here';
    pendingPings.delete(message.channel.id);

    return message.channel.send({
      content: `${mention} ${pending.content}`,
      allowedMentions: { parse: ['everyone'] }
    });
  }

  if (!prompt) {
    return message.reply('❓ Please write something after `?ai` — for example: `?ai how are you?`');
  }

  if (containsOffensiveLanguage(prompt)) {
    try { await message.member.timeout(60 * 60 * 1000, 'Used offensive language with ?ai'); } catch {}
    return message.reply({ content: '🔇 You have been timed out for 1 hour for using offensive language.', allowedMentions: { parse: [] } });
  }

  // Everyone/here ping request
  if (containsPingWord(prompt)) {
    const pingType = extractPingType(prompt);

    if (!isAdmin(message.author.id)) {
      return message.reply({ content: '⚠️ You need a confirmation from an Admin to do this.', allowedMentions: { parse: [] } });
    }

    const pingContent = prompt.replace(/@?everyone/gi, '').replace(/@?here/gi, '').trim();

    pendingPings.set(message.channel.id, {
      pingType,
      content: pingContent,
      requestedBy: message.author.id
    });

    return message.reply({
      content: `⏳ Wait for an Admin to confirm to ping @${pingType}. An admin can type \`?ai confirm\` to send it.`,
      allowedMentions: { parse: [] }
    });
  }

  // Mod action request
  const modAction = getModAction(prompt);
  if (modAction) {
    if (!isAdmin(message.author.id)) {
      return message.reply({ content: '⚠️ You need a confirmation from an Admin to do this.', allowedMentions: { parse: [] } });
    }

    const permKey = ACTION_TO_PERMISSION[modAction];
    if (!adminSettings.modPermissions[permKey]) {
      return message.reply(`⚠️ The **${modAction}** command is currently **disabled**. Enable it with \`?ai adminsettings\`.`);
    }

    const rest = prompt.slice(modAction.length).trim();
    const targetId = extractUserId(rest);

    if (targetId) {
      // User was mentioned directly - execute right away
      const reason = rest.replace(/<@!?\d+>/, '').trim() || `Action requested via Bikkini AI by ${message.author.tag}`;
      return await executeModAction(message, modAction, targetId, reason);
    }

    // No user mentioned - show a user select menu
    pendingModSelections.set(message.author.id, { action: modAction, reason: rest || `Action requested via Bikkini AI by ${message.author.tag}` });

    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('modaction_userselect')
        .setPlaceholder(`Select a user to ${modAction}`)
    );

    return message.reply({ content: `Select the user you want to **${modAction}**:`, components: [row] });
  }

  const userId = message.author.id;
  await message.channel.sendTyping();

  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: prompt });
  if (history.length > 10) history.splice(0, history.length - 10);

  const userLanguage = getUserLanguage(userId);
  let systemPrompt = SYSTEM_PROMPT_BASE;
  if (userLanguage) {
    systemPrompt += `\nIMPORTANT: This user has set their preferred language to "${userLanguage}". ALWAYS respond in that language.`;
  } else {
    systemPrompt += `\nVERY IMPORTANT: Always detect the language the user is writing in and respond in that EXACT same language.`;
  }

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      max_tokens: 1024
    });

    const reply = response.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    const safeReply = reply.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');

    if (safeReply.length <= 1900) {
      await message.reply({ content: safeReply, allowedMentions: { parse: ['users'] } });
    } else {
      const chunks = safeReply.match(/.{1,1900}/gs);
      for (const chunk of chunks) {
        await message.channel.send({ content: chunk, allowedMentions: { parse: ['users'] } });
      }
    }
  } catch (err) {
    console.error('[AI ERROR]', err);
    await message.reply('❌ Something went wrong. Please try again.');
  }
}

// ─── /membersettings with Select Menu ──────────────────────────────────────────
async function handleMemberSettings(message) {
  const current = getUserLanguage(message.author.id);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('⚙️ Member Settings')
    .setDescription(`Current language: **${current || 'Auto-detect'}**\n\nUse the menu below to manage your settings.`);

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

// ─── /adminsettings with Select Menu ────────────────────────────────────────────
async function handleAdminSettings(message) {
  if (!isAdmin(message.author.id)) {
    return message.reply({ content: '❌ Only admins can use this command.', allowedMentions: { parse: [] } });
  }

  const settings = loadAdminSettings();
  const mp = settings.modPermissions;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🛠️ Admin Settings')
    .addFields(
      { name: 'AI Status', value: settings.aiOnline ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'Ban', value: mp.ban ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: 'Kick', value: mp.kick ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: 'Timeout', value: mp.timeout ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: 'Mute', value: mp.mute ? '✅ Enabled' : '❌ Disabled', inline: true }
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
        { label: 'Mute: Disable', value: 'mute_off', emoji: '❌' }
      ])
  );

  await message.reply({ embeds: [embed], components: [row] });
}

// ─── Other commands ─────────────────────────────────────────────────────────────
function handleHelp(message) {
  message.reply([
    '**🤖 Bikkini AI – Commands**', '',
    '`?ai <question>` – Ask Bikkini AI anything',
    '`?ai membersettings` – Manage your personal settings',
    '`?ai adminsettings` – Admin controls (Admin only)',
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

// ─── Message Router ─────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('?')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'ai') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'membersettings') return await handleMemberSettings(message);
    if (sub === 'adminsettings') return await handleAdminSettings(message);
    return await handleAI(message, args.join(' '));
  }

  switch (command) {
    case 'help': handleHelp(message); break;
    case 'info': handleInfo(message); break;
    case 'reset': handleReset(message); break;
  }
});

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Member Settings Select Menu ───────────────────────────────────────────
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
      const input = new TextInputBuilder()
        .setCustomId('language_input')
        .setLabel('Language / Country')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. German, Spanish, Turkish...')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }
  }

  // ── Admin Settings Select Menu ────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'adminsettings_menu') {
    if (!isAdmin(interaction.user.id)) {
      return await interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });
    }

    const choice = interaction.values[0];
    const settings = loadAdminSettings();

    const map = {
      ai_online: () => { settings.aiOnline = true; return '🟢 Bikkini AI is now **online**.'; },
      ai_offline: () => { settings.aiOnline = false; return '🔴 Bikkini AI is now **offline**.'; },
      ban_on: () => { settings.modPermissions.ban = true; return '✅ **Ban** command enabled.'; },
      ban_off: () => { settings.modPermissions.ban = false; return '❌ **Ban** command disabled.'; },
      kick_on: () => { settings.modPermissions.kick = true; return '✅ **Kick** command enabled.'; },
      kick_off: () => { settings.modPermissions.kick = false; return '❌ **Kick** command disabled.'; },
      timeout_on: () => { settings.modPermissions.timeout = true; return '✅ **Timeout** command enabled.'; },
      timeout_off: () => { settings.modPermissions.timeout = false; return '❌ **Timeout** command disabled.'; },
      mute_on: () => { settings.modPermissions.mute = true; return '✅ **Mute** command enabled.'; },
      mute_off: () => { settings.modPermissions.mute = false; return '❌ **Mute** command disabled.'; }
    };

    const msg = map[choice] ? map[choice]() : '❌ Unknown option.';
    saveAdminSettings(settings);
    return await interaction.reply({ content: msg, ephemeral: true });
  }

  // ── Language Modal Submit ─────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'language_modal') {
    const language = interaction.fields.getTextInputValue('language_input');
    setUserLanguage(interaction.user.id, language);
    return await interaction.reply({ content: `✅ Your language has been set to **${language}**!`, ephemeral: true });
  }

  // ── Mod Action User Select ────────────────────────────────────────────────
  if (interaction.isUserSelectMenu() && interaction.customId === 'modaction_userselect') {
    const pending = pendingModSelections.get(interaction.user.id);
    if (!pending) {
      return await interaction.reply({ content: '❌ This request has expired.', ephemeral: true });
    }

    const targetId = interaction.values[0];
    pendingModSelections.delete(interaction.user.id);

    await interaction.update({ content: `Processing **${pending.action}** on <@${targetId}>...`, components: [] });
    await executeModAction(interaction, pending.action, targetId, pending.reason);
  }
});

client.once('ready', () => {
  console.log(`✅ Bikkini AI is online as: ${client.user.tag}`);
  client.user.setActivity('?ai | Bikkini AI', { type: 3 });
});

client.login(process.env.DISCORD_TOKEN);
