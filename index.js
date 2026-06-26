require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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
// Speichert pending everyone/here ping requests: messageId -> { channelId, content, requestedBy }
const pendingPings = new Map();

// ─── Member Settings ────────────────────────────────────────────────────────────
function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}
function getUserLanguage(userId) {
  const settings = loadSettings();
  return settings[userId]?.language || null;
}
function setUserLanguage(userId, language) {
  const settings = loadSettings();
  if (!settings[userId]) settings[userId] = {};
  settings[userId].language = language;
  saveSettings(settings);
}

// ─── Admin Settings ─────────────────────────────────────────────────────────────
function loadAdminSettings() {
  if (!fs.existsSync(ADMIN_SETTINGS_FILE)) return { aiOnline: true, modCommandsEnabled: false };
  return JSON.parse(fs.readFileSync(ADMIN_SETTINGS_FILE, 'utf8'));
}
function saveAdminSettings(data) {
  fs.writeFileSync(ADMIN_SETTINGS_FILE, JSON.stringify(data, null, 2));
}
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
  const lower = text.toLowerCase();
  return BLOCKED_WORDS.some(word => lower.includes(word));
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
  const lower = text.toLowerCase();
  return PING_WORDS.some(word => lower.includes(word));
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

// ─── Execute real mod action ───────────────────────────────────────────────────
async function executeModAction(message, action, prompt) {
  const targetId = extractUserId(prompt);
  if (!targetId) return message.reply('❌ Please mention the user you want to apply this action to.');

  const reason = prompt.replace(/<@!?\d+>/, '').trim() || `Action requested via Bikkini AI by ${message.author.tag}`;

  try {
    const member = await message.guild.members.fetch(targetId);
    switch (action) {
      case 'ban':
        await member.ban({ reason });
        return message.reply(`✅ <@${targetId}> has been **banned**.\n**Reason:** ${reason}`);
      case 'kick':
        await member.kick(reason);
        return message.reply(`✅ <@${targetId}> has been **kicked**.\n**Reason:** ${reason}`);
      case 'timeout':
      case 'mute':
        await member.timeout(60 * 60 * 1000, reason);
        return message.reply(`✅ <@${targetId}> has been **timed out for 1 hour**.\n**Reason:** ${reason}`);
      case 'unban':
        await message.guild.members.unban(targetId, reason);
        return message.reply(`✅ <@${targetId}> has been **unbanned**.`);
      case 'unmute':
        await member.timeout(null);
        return message.reply(`✅ <@${targetId}> has been **unmuted**.`);
    }
  } catch (err) {
    console.error('[MOD ACTION ERROR]', err);
    return message.reply('❌ Could not perform this action. Check my permissions and role position.');
  }
}

// ─── /ai Handler ───────────────────────────────────────────────────────────────
async function handleAI(message, prompt) {
  const adminSettings = loadAdminSettings();

  if (!adminSettings.aiOnline) {
    return message.reply({ content: '🔴 Bikkini AI is currently offline (turned off by an Admin).', allowedMentions: { parse: [] } });
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

    // Admin requested a ping - show confirm button
    const pingContent = prompt.replace(/@?everyone/gi, '').replace(/@?here/gi, '').trim();

    const confirmMsg = await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⚠️ Confirm Ping')
        .setDescription(`You are about to ping **@${pingType}**.\n\n**Message:** ${pingContent || '(no extra message)'}\n\nAre you sure?`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirmping_${pingType}`).setLabel('✅ Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancelping').setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
      )]
    });

    pendingPings.set(confirmMsg.id, {
      channelId: message.channel.id,
      pingType,
      content: pingContent,
      requestedBy: message.author.id
    });
    return;
  }

  const modAction = getModAction(prompt);
  if (modAction) {
    if (!isAdmin(message.author.id)) {
      return message.reply({ content: '⚠️ You need a confirmation from an Admin to do this.', allowedMentions: { parse: [] } });
    }
    if (!adminSettings.modCommandsEnabled) {
      return message.reply('⚠️ Mod commands via Bikkini AI are currently **disabled**. An admin can enable them in `?ai adminsettings`.');
    }
    return await executeModAction(message, modAction, prompt.slice(modAction.length).trim());
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

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🛠️ Admin Settings')
    .addFields(
      { name: 'AI Status', value: settings.aiOnline ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'Mod Commands', value: settings.modCommandsEnabled ? '✅ Enabled' : '❌ Disabled', inline: true }
    )
    .setDescription('Use the menu below to change settings.');

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('adminsettings_menu')
      .setPlaceholder('Choose a setting to change')
      .addOptions([
        { label: 'AI: Online', description: 'Turn Bikkini AI on', value: 'ai_online', emoji: '🟢' },
        { label: 'AI: Offline', description: 'Turn Bikkini AI off', value: 'ai_offline', emoji: '🔴' },
        { label: 'Mod Commands: Enable', description: 'Allow ban/kick/timeout via AI', value: 'mod_on', emoji: '✅' },
        { label: 'Mod Commands: Disable', description: 'Disable ban/kick/timeout via AI', value: 'mod_off', emoji: '❌' }
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

// ─── Interactions (Select Menus, Buttons, Modals) ──────────────────────────────
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

    if (choice === 'ai_online') {
      settings.aiOnline = true;
      saveAdminSettings(settings);
      return await interaction.reply({ content: '🟢 Bikkini AI is now **online**.', ephemeral: true });
    }
    if (choice === 'ai_offline') {
      settings.aiOnline = false;
      saveAdminSettings(settings);
      return await interaction.reply({ content: '🔴 Bikkini AI is now **offline**.', ephemeral: true });
    }
    if (choice === 'mod_on') {
      settings.modCommandsEnabled = true;
      saveAdminSettings(settings);
      return await interaction.reply({ content: '✅ Mod commands **enabled**.', ephemeral: true });
    }
    if (choice === 'mod_off') {
      settings.modCommandsEnabled = false;
      saveAdminSettings(settings);
      return await interaction.reply({ content: '❌ Mod commands **disabled**.', ephemeral: true });
    }
  }

  // ── Language Modal Submit ─────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'language_modal') {
    const language = interaction.fields.getTextInputValue('language_input');
    setUserLanguage(interaction.user.id, language);
    return await interaction.reply({ content: `✅ Your language has been set to **${language}**!`, ephemeral: true });
  }

  // ── Ping Confirm/Cancel Buttons ───────────────────────────────────────────
  if (interaction.isButton()) {
    if (interaction.customId === 'cancelping') {
      pendingPings.delete(interaction.message.id);
      return await interaction.update({ content: '❌ Ping cancelled.', embeds: [], components: [] });
    }

    if (interaction.customId.startsWith('confirmping_')) {
      const pending = pendingPings.get(interaction.message.id);
      if (!pending) {
        return await interaction.update({ content: '❌ This request has expired.', embeds: [], components: [] });
      }

      if (interaction.user.id !== pending.requestedBy && !isAdmin(interaction.user.id)) {
        return await interaction.reply({ content: '❌ Only the requester or an admin can confirm this.', ephemeral: true });
      }

      const pingType = pending.pingType;
      const mention = pingType === 'everyone' ? '@everyone' : '@here';

      await interaction.update({ content: '✅ Confirmed! Sending ping...', embeds: [], components: [] });

      const channel = client.channels.cache.get(pending.channelId);
      if (channel) {
        await channel.send({
          content: `${mention} ${pending.content}`,
          allowedMentions: { parse: [pingType === 'everyone' ? 'everyone' : 'everyone'] }
        });
      }

      pendingPings.delete(interaction.message.id);
    }
  }
});

client.once('ready', () => {
  console.log(`✅ Bikkini AI is online as: ${client.user.tag}`);
  client.user.setActivity('?ai | Bikkini AI', { type: 3 });
});

client.login(process.env.DISCORD_TOKEN);
