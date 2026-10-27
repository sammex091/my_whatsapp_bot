import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import OpenAI from 'openai';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const recentMessages = new Map();
const warnedUsers = new Map();
let pairingCodeRequested = false;

function unwrapMessage(message) {
  return message?.ephemeralMessage?.message
    ?? message?.viewOnceMessageV2?.message
    ?? message?.viewOnceMessage?.message
    ?? message;
}

function getText(message) {
  const msg = unwrapMessage(message);
  return msg?.conversation
    ?? msg?.extendedTextMessage?.text
    ?? msg?.imageMessage?.caption
    ?? msg?.videoMessage?.caption
    ?? '';
}

function sameJid(a, b) {
  return Boolean(a && b && jidNormalizedUser(a) === jidNormalizedUser(b));
}

async function isGroupAdmin(sock, groupJid, userJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find(p => sameJid(p.id, userJid));
    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch {
    return false;
  }
}

function checkSpam(chatId, sender, text) {
  const now = Date.now();
  const key = `${chatId}:${sender}`;
  const normalized = text.trim().toLowerCase();
  const previous = recentMessages.get(key) ?? [];
  const fresh = previous.filter(item => now - item.time < 8000);
  fresh.push({ time: now, text: normalized });
  recentMessages.set(key, fresh);
  return fresh.length >= 7 || fresh.filter(item => item.text === normalized).length >= 4;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['SamBot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // Pair with a code instead of scanning a QR on the same phone.
    // Set BOT_PHONE_NUMBER in .env using international digits, without + or spaces.
    if (!state.creds.registered && process.env.BOT_PHONE_NUMBER && !pairingCodeRequested && (qr || connection === 'connecting')) {
      pairingCodeRequested = true;
      try {
        const number = process.env.BOT_PHONE_NUMBER.replace(/\D/g, '');
        const code = await sock.requestPairingCode(number);
        console.log(`\nWhatsApp pairing code: ${code}`);
        console.log('On your phone: WhatsApp > Linked devices > Link a device > Link with phone number instead.');
        console.log('Enter the pairing code shown above. Keep Termux open.');
      } catch (error) {
        pairingCodeRequested = false;
        console.error('Could not request pairing code:', error.message);
      }
    } else if (qr && !process.env.BOT_PHONE_NUMBER) {
      console.log('\nScan this QR code in WhatsApp > Linked devices:\n');
      qrcode.generate(qr, { small: true });
      console.log('If WhatsApp is on this same phone, use phone-number pairing by setting BOT_PHONE_NUMBER in .env.');
    }

    if (connection === 'open') console.log('✅ WhatsApp bot connected.');
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        pairingCodeRequested = false;
        console.log('Connection closed. Reconnecting...');
        setTimeout(() => startBot().catch(console.error), 3000);
      } else {
        console.log('Logged out. Remove auth_info and link the account again.');
      }
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action !== 'add') return;
    for (const participant of participants) {
      try {
        await sock.sendMessage(id, {
          text: `Welcome @${participant.split('@')[0]}! Please read the group rules.`,
          mentions: [participant]
        });
      } catch (error) {
        console.error('Welcome message failed:', error.message);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const chatId = m.key.remoteJid;
      const sender = m.key.participant || chatId;
      const isGroup = chatId.endsWith('@g.us');
      const text = getText(m.message).trim();
      if (!text) continue;

      if (isGroup && !text.startsWith('.')) {
        if (await isGroupAdmin(sock, chatId, sender)) continue;
        if (checkSpam(chatId, sender, text)) {
          try { await sock.sendMessage(chatId, { delete: m.key }); } catch {}
          const warningKey = `${chatId}:${sender}`;
          const now = Date.now();
          if (now - (warnedUsers.get(warningKey) || 0) > 15000) {
            warnedUsers.set(warningKey, now);
            await sock.sendMessage(chatId, {
              text: `⚠️ @${sender.split('@')[0]}, please slow down. Repeated messages may be treated as spam.`,
              mentions: [sender]
            });
          }
          continue;
        }
      }

      const lower = text.toLowerCase();
      if (lower === '.ping') {
        await sock.sendMessage(chatId, { text: '🏓 Pong! Bot is online.' }, { quoted: m });
        continue;
      }
      if (lower === '.menu' || lower === '.help') {
        await sock.sendMessage(chatId, { text: [
          '🤖 *SamBot Commands*', '',
          '.ping — check whether the bot is online',
          '.menu — show this menu',
          '.ai your question — ask the AI (API key required)',
          '.kick — reply to a member’s message with this command (group admins only)',
          '',
          'Group moderation commands require the bot to have the necessary group permissions.'
        ].join('\n') }, { quoted: m });
        continue;
      }
      if (lower === '.kick') {
        if (!isGroup) {
          await sock.sendMessage(chatId, { text: 'This command only works in groups.' }, { quoted: m });
          continue;
        }
        const senderIsAdmin = await isGroupAdmin(sock, chatId, sender);
        const botJid = jidNormalizedUser(sock.user.id);
        const botIsAdmin = await isGroupAdmin(sock, chatId, botJid);
        if (!senderIsAdmin) {
          await sock.sendMessage(chatId, { text: 'Only group admins can use .kick.' }, { quoted: m });
          continue;
        }
        if (!botIsAdmin) {
          await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: m });
          continue;
        }
        const context = unwrapMessage(m.message)?.extendedTextMessage?.contextInfo;
        const target = context?.participant;
        if (!target) {
          await sock.sendMessage(chatId, { text: 'Reply to the member’s message with .kick.' }, { quoted: m });
          continue;
        }
        if (sameJid(target, botJid)) {
          await sock.sendMessage(chatId, { text: 'I cannot remove myself with this command.' }, { quoted: m });
          continue;
        }
        try {
          await sock.groupParticipantsUpdate(chatId, [target], 'remove');
          await sock.sendMessage(chatId, { text: 'Member removal request completed.' });
        } catch {
          await sock.sendMessage(chatId, { text: 'Could not remove that member. Check group permissions.' });
        }
        continue;
      }
      if (lower.startsWith('.ai ')) {
        if (!openai) {
          await sock.sendMessage(chatId, { text: 'AI is not configured yet. Add OPENAI_API_KEY to your local .env file, then restart the bot.' }, { quoted: m });
          continue;
        }
        const prompt = text.slice(4).trim();
        if (!prompt) {
          await sock.sendMessage(chatId, { text: 'Usage: .ai explain photosynthesis' }, { quoted: m });
          continue;
        }
        try {
          const response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'You are a helpful WhatsApp assistant. Keep replies clear and concise.' },
              { role: 'user', content: prompt }
            ],
            max_tokens: 350
          });
          await sock.sendMessage(chatId, {
            text: response.choices?.[0]?.message?.content?.trim() || 'I could not generate a reply.'
          }, { quoted: m });
        } catch (error) {
          console.error('AI request failed:', error.message);
          await sock.sendMessage(chatId, { text: 'The AI service is unavailable right now. Try again later.' }, { quoted: m });
        }
        continue;
      }
      if (/^(hi|hello|hey|good morning|good afternoon|good evening)[!. ]*$/i.test(text)) {
        await sock.sendMessage(chatId, { text: 'Hey! 👋 Type .menu to see what I can do.' }, { quoted: m });
      }
    }
  });
}

startBot().catch(error => {
  console.error('Could not start bot:', error);
  process.exit(1);
});
