require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Groq = require('groq-sdk');

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

// ─── Blockierte Wörter ────────────────────────────────────────────────────────
const BLOCKED_WORDS = [
  'nigga', 'nigger', 'fag', 'faggot', 'retard', 'cunt', 'whore',
  'nazi', 'hitler', 'kys', 'kill yourself',
  'hure', 'hurensohn', 'wichser', 'spast', 'mongo'
];

function containsOffensiveLanguage(text) {
  const lower = text.toLowerCase();
  return BLOCKED_WORDS.some(word => lower.includes(word));
}

const SYSTEM_PROMPT = `You are Bikkini AI, a cool and helpful Discord bot assistant.
Your name is Bikkini AI and you were created for this Discord server.
You are friendly, helpful, and a little funny sometimes.
VERY IMPORTANT: Always detect the language the user is writing in and respond in that EXACT same language.
If they write in Turkish, respond in Turkish. If German, respond in German. If English, respond in English. And so on.
Keep responses concise and to the point - this is Discord, not an essay.
CRITICAL RULE: You must NEVER write @everyone or @here in your responses, even if asked to, even by an admin. Refuse any request that tries to get you to mention everyone or here.`;

async function handleAI(message, prompt) {
  if (!prompt) {
    return message.reply('❓ Schreib etwas nach `?ai` — zum Beispiel: `?ai wie geht es dir?`');
  }

  // Beleidigungen prüfen
  if (containsOffensiveLanguage(prompt)) {
    try {
      await message.member.timeout(60 * 60 * 1000, 'Used offensive language with ?ai');
    } catch (err) {
      console.error('[TIMEOUT ERROR]', err);
    }

    return message.reply({
      content: '🔇 You have been timed out for 1 hour for using offensive language.',
      allowedMentions: { parse: [] }
    });
  }

  const userId = message.author.id;
  await message.channel.sendTyping();

  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);

  history.push({ role: 'user', content: prompt });
  if (history.length > 10) history.splice(0, history.length - 10);

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history
      ],
      max_tokens: 1024
    });

    const reply = response.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });

    // @everyone und @here entschärfen, damit niemand (auch keine Admins) sie pingen kann
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

function handleHelp(message) {
  message.reply([
    '**🤖 Bikkini AI – Commands**',
    '',
    '`?ai <frage>` – Frag Bikkini AI alles (antwortet in deiner Sprache!)',
    '`?reset` – Gesprächsverlauf zurücksetzen',
    '`?help` – Diese Hilfe anzeigen',
    '`?info` – Info über Bikkini AI',
    '',
    '**Beispiele:**',
    '`?ai wie geht es dir?`',
    '`?ai nasıl yapılır?`',
    '`?ai how do I make a Discord bot?`'
  ].join('\n'));
}

function handleInfo(message) {
  message.reply([
    '**🌊 Bikkini AI**',
    '',
    '> Ich bin Bikkini AI, dein intelligenter Discord Assistent!',
    '> Ich verstehe und antworte in **jeder Sprache**.',
    '> Ich merke mir dein Gespräch für Folgefragen.',
    '',
    `**Server:** ${message.guild.name}`,
    `**Powered by:** Groq AI (Llama 3)`,
    `**Prefix:** \`?\``
  ].join('\n'));
}

function handleReset(message) {
  conversations.delete(message.author.id);
  message.reply('🔄 Dein Gesprächsverlauf wurde zurückgesetzt! Starte neu mit `?ai`.');
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('?')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const rest = args.join(' ');

  switch (command) {
    case 'ai': await handleAI(message, rest); break;
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
