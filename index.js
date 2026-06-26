require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
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

// ─── Member Settings (per-user language) ──────────────────────────────────────
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

// ─── Admin Settings (bot online/offline, mod commands enabled) ───────────────
function loadAdminSettings() {
  if (!fs.existsSync(ADMIN_SETTINGS_FILE)) {
    return { aiOnline: true, modCommandsEnabled: false };
  }
  return JSON.parse(fs.readFileSync(ADMIN_SETTINGS_FILE, 'utf8'));
}
function saveAdminSettings(data) {
  fs.writeFileSync(ADMIN_SETTINGS_FILE, JSON.stringify(data, null, 2));
}

function isAdmin(userId) {
  return process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()).includes(userId) : false;
}

// ─── Blocked offensive words ───────────────────────────────────────────────────
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

// ─── Mod action detection ───────────────────────────────────────────────────────
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

const SYSTEM_PROMPT_BASE = `You are Bikkini AI, a cool and helpful Discord bot assistant.
Your name is Bikkini AI and you were created for this Discord server.
You are friendly, helpful, and a little funny sometimes.
Keep responses concise and to the point - this is Discord, not an essay.
CRITICAL RULE: You must NEVER write @everyone or @here in your responses, even if asked to, even by an admin.`;

// ─── Extract Discord user ID from a mention in text ───────────────────────────
function extractUserId(text) {
  const match = text.match(/<@!?(\d+)>/);
  return match ? match[1] : null;
}

// ─── Execute a real mod action (admin only, when enabled) ─────────────────────
async function executeModAction(message, action, prompt) {
  const targetId = extractUserId(prompt);
  if (!targetId) {
    return message.reply('❌ Please mention the user you want to apply this action to.');
  }

  const reasonMatch = prompt.replace(/<@!?\d+>/, '').trim();
  const reason = reasonMatch || `Action requested via Bikkini AI by ${message.author.tag}`;

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
        await member.timeout(60 * 60 * 1000, reason);
        return message.reply(`✅ <@${targetId}> has been **timed out for 1 hour**.\n**Reason:** ${reason}`);
      case 'mute':
        await member.timeout(60 * 60 * 1000, reason);
        return message.reply(`✅ <@${targetId}> has been **muted (timed out) for 1 hour**.\n**Reason:** ${reason}`);
      case 'unmute':
      case 'unban':
        if (action === 'unban') {
          await message.guild.members.unban(targetId, reason);
          return message.reply(`✅ <@${targetId}> has been **unbanned**.`);
        } else {
          await member.timeout(null);
          return message.reply(`✅ <@${targetId}> has been **unmuted**.`);
        }
      default:
        return message.reply('❌ Unknown action.');
    }
  } catch (err) {
    console.error('[MOD ACTION ERROR]', err);
    return message.reply('❌ Could not perform this action. Check my permissions and role position.');
  }
}

// ─── /ai Handler ───────────────────────────────────────────────────────────────
async function handleAI(message, prompt) {
  const adminSettings = loadAdminSettings();

  // AI offline check
  if (!adminSettings.aiOnline) {
    return message.reply({ content: '🔴 Bikkini AI is currently offline (turned off by an Admin).', allowedMentions: { parse: [] } });
  }

  if (!prompt) {
    return message.reply('❓ Please write something after `?ai` — for example: `?ai how are you?`');
  }

  // Offensive language check → timeout
  if (containsOffensiveLanguage(prompt)) {
    try {
      await message.member.timeout(60 * 60 * 1000, 'Used offensive language with ?ai');
    } catch (err) {
      console.error('[TIMEOUT ERROR]', err);
    }
    return message.reply({ content: '🔇 You have been timed out for 1 hour for using offensive language.', allowedMentions: { parse: [] } });
  }

  // Everyone/Here ping attempt
  if (containsPingWord(prompt) && !isAdmin(message.author.id)) {
    return message.reply({ content: '⚠️ You need a confirmation from an Admin to do this.', allowedMentions: { parse: [] } });
  }

  // Mod action attempt
  const modAction = getModAction(prompt);
  if (modAction) {
    const isAdminUser = isAdmin(message.author.id);

    if (!isAdminUser) {
      return message.reply({ content: '⚠️ You need a confirmation from an Admin to do this.', allowedMentions: { parse: [] } });
    }

    // Admin user - check if mod commands are enabled
    if (!adminSettings.modCommandsEnabled) {
      return message.reply('⚠️ Mod commands via Bikkini AI are currently **disabled**. Enable them with `?ai adminsettings modcommands on`.');
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
    systemPrompt += `\nIMPORTANT: This user has set their preferred language to "${userLanguage}". ALWAYS respond in that language, regardless of what language they write in.`;
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

// ─── /membersettings Handler ───────────────────────────────────────────────────
function handleMemberSettings(message, args) {
  const sub = args[0]?.toLowerCase();

  if (sub === 'language' || sub === 'lang') {
    const language = args.slice(1).join(' ').trim();

    if (!language) {
      const current = getUserLanguage(message.author.id);
      return message.reply([
        '**🌐 Your Language Setting**',
        '',
        current ? `Your language is currently set to: **${current}**` : 'No language set — Bikkini AI auto-detects your language.',
        '',
        'To set a language: `?ai membersettings language <language>`',
        'To reset: `?ai membersettings language reset`'
      ].join('\n'));
    }

    if (language.toLowerCase() === 'reset' || language.toLowerCase() === 'auto') {
      const settings = loadSettings();
      if (settings[message.author.id]) delete settings[message.author.id].language;
      saveSettings(settings);
      return message.reply('✅ Language reset to auto-detect!');
    }

    setUserLanguage(message.author.id, language);
    return message.reply(`✅ Your language has been set to **${language}**!`);
  }

  return message.reply([
    '**⚙️ Member Settings**',
    '',
    '`?ai membersettings language <language>` – Set your preferred language',
    '`?ai membersettings language reset` – Go back to auto-detect'
  ].join('\n'));
}

// ─── /adminsettings Handler ─────────────────────────────────────────────────────
function handleAdminSettings(message, args) {
  if (!isAdmin(message.author.id)) {
    return message.reply({ content: '❌ Only admins can use this command.', allowedMentions: { parse: [] } });
  }

  const sub = args[0]?.toLowerCase();
  const settings = loadAdminSettings();

  // ?ai adminsettings ai online/offline
  if (sub === 'ai') {
    const state = args[1]?.toLowerCase();
    if (state === 'offline') {
      settings.aiOnline = false;
      saveAdminSettings(settings);
      return message.reply('🔴 **Bikkini AI is now offline.** All `?ai` requests will be ignored until turned back on.');
    }
    if (state === 'online') {
      settings.aiOnline = true;
      saveAdminSettings(settings);
      return message.reply('🟢 **Bikkini AI is now online.**');
    }
    return message.reply('Usage: `?ai adminsettings ai online` or `?ai adminsettings ai offline`');
  }

  // ?ai adminsettings modcommands on/off
  if (sub === 'modcommands' || sub === 'mod') {
    const state = args[1]?.toLowerCase();
    if (state === 'on' || state === 'enable') {
      settings.modCommandsEnabled = true;
      saveAdminSettings(settings);
      return message.reply('✅ **Mod commands enabled.** Admins can now use `?ai ban/kick/timeout/mute @user reason`.');
    }
    if (state === 'off' || state === 'disable') {
      settings.modCommandsEnabled = false;
      saveAdminSettings(settings);
      return message.reply('❌ **Mod commands disabled.**');
    }
    return message.reply('Usage: `?ai adminsettings modcommands on` or `?ai adminsettings modcommands off`');
  }

  // Default: show overview
  return message.reply([
    '**🛠️ Admin Settings**',
    '',
    `**AI Status:** ${settings.aiOnline ? '🟢 Online' : '🔴 Offline'}`,
    `**Mod Commands:** ${settings.modCommandsEnabled ? '✅ Enabled' : '❌ Disabled'}`,
    '',
    '**Commands:**',
    '`?ai adminsettings ai online` / `offline` – Turn Bikkini AI on/off',
    '`?ai adminsettings modcommands on` / `off` – Allow admins to ban/kick/timeout via AI',
    '',
    '**Mod usage (when enabled, admins only):**',
    '`?ai ban @user reason`',
    '`?ai kick @user reason`',
    '`?ai timeout @user reason`',
    '`?ai mute @user reason`',
    '`?ai unban @user`',
    '`?ai unmute @user`'
  ].join('\n'));
}

// ─── Other Commands ─────────────────────────────────────────────────────────────
function handleHelp(message) {
  message.reply([
    '**🤖 Bikkini AI – Commands**',
    '',
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
    '**🌊 Bikkini AI**',
    '',
    '> I am Bikkini AI, your intelligent Discord assistant!',
    '> I understand and respond in **every language**.',
    '',
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

    if (sub === 'membersettings') {
      return handleMemberSettings(message, args.slice(1));
    }
    if (sub === 'adminsettings') {
      return handleAdminSettings(message, args.slice(1));
    }
    return await handleAI(message, args.join(' '));
  }

  switch (command) {
    case 'help': handleHelp(message); break;
    case 'info': handleInfo(message); break;
    case 'reset': handleReset(message); break;
  }
});

client.once('ready', () => {
  console.log(`✅ Bikkini AI is online as: ${client.user.tag}`);
  client.user.setActivity('?ai | Bikkini AI', { type: 3 });
});

client.login(process.env.DISCORD_TOKEN);
