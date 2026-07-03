const { App } = require('@slack/bolt');
const cron = require('node-cron');
const { Pool } = require('pg');
const { google } = require('googleapis');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APOLLO_RELIABILITY_SUBTEAM_ID = 'S0B8C37C8RE';
const APOLLO_BOT_USER_ID = 'U09R8549KQV';
const REACT_EMOJI = 'set-up';
const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL_ID;
const DM_USERS = ['U03PZ6EKVT2', 'U082FH8ER6G'];
const RESPONSE_WINDOW_MS = 4 * 60 * 60 * 1000;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const pendingThreads = new Map();
const userCache = {};

// --- Google Sheets ---
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureSheetTabs() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existingTitles = res.data.sheets.map(s => s.properties.title);

  const requests = [];
  if (!existingTitles.includes('Apollo Reliability Mentions')) {
    requests.push({ addSheet: { properties: { title: 'Apollo Reliability Mentions' } } });
  }
  if (!existingTitles.includes('Apollo Mentions')) {
    requests.push({ addSheet: { properties: { title: 'Apollo Mentions' } } });
  }
  if (!existingTitles.includes('Apollo Conversations')) {
    requests.push({ addSheet: { properties: { title: 'Apollo Conversations' } } });
  }
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  }

  const tabHeaders = [
    ['Apollo Reliability Mentions', [['Timestamp', 'Channel', 'Mentioned By', 'Thread Link', 'Thread Contents', '# of Replies', 'Response Time (mins)', 'Got Response?']]],
    ['Apollo Mentions', [['Timestamp', 'Channel', 'Mentioned By', 'Thread Link', '# of Replies']]],
    ['Apollo Conversations', [['Thread ID', 'Timestamp', 'Channel', 'Speaker', 'Role', 'Message', 'Thread Link']]],
  ];

  for (const [tab, headers] of tabHeaders) {
    const check = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1` });
    if (!check.data.values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: headers },
      });
    }
  }
}

async function appendToSheet(tab, rows) {
  const sheets = getSheetsClient();
  const values = Array.isArray(rows[0]) ? rows : [rows];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

// --- DB ---
async function setupDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mentions (
      id SERIAL PRIMARY KEY,
      channel_name TEXT,
      link TEXT,
      mentioned_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS apollo_conversations (
      id SERIAL PRIMARY KEY,
      thread_id TEXT,
      channel_name TEXT,
      thread_link TEXT,
      speaker TEXT,
      role TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// --- Helpers ---
async function getUserName(client, userId) {
  if (!userId) return 'Unknown';
  if (userCache[userId]) return userCache[userId];
  try {
    const res = await client.users.info({ user: userId });
    userCache[userId] = res.user.real_name || res.user.name || userId;
  } catch {
    userCache[userId] = userId;
  }
  return userCache[userId];
}

async function getGroupMembers(client) {
  try {
    const res = await client.usergroups.list({ include_users: true });
    const group = (res.usergroups || []).find(g => g.id === APOLLO_RELIABILITY_SUBTEAM_ID);
    return group?.users || [];
  } catch {
    return [];
  }
}

async function getThreadData(client, channel, threadTs) {
  const result = await client.conversations.replies({ channel, ts: threadTs });
  return result.messages || [];
}

async function getChannelName(client, channel) {
  try {
    const res = await client.conversations.info({ channel });
    return res.channel?.name ? `#${res.channel.name}` : 'a channel';
  } catch {
    return 'a channel';
  }
}

// --- Message handler ---
app.message(async ({ message, client, logger }) => {
  if (!message.text) return;

  const isReply = !!(message.thread_ts && message.thread_ts !== message.ts);
  const threadTs = message.thread_ts || message.ts;
  const threadKey = `${message.channel}-${threadTs}`;

  const isReliabilityMention = message.text.includes(`<!subteam^${APOLLO_RELIABILITY_SUBTEAM_ID}`);
  const isApolloMention = message.text.includes(`<@${APOLLO_BOT_USER_ID}>`);
  const isApolloReply = message.user === APOLLO_BOT_USER_ID || message.bot_id != null && message.username?.toLowerCase().includes('apollo');

  // --- @apollo-reliability mention ---
  if (isReliabilityMention) {
    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: threadTs,
        name: REACT_EMOJI,
      }).catch(err => { if (err.data?.error !== 'already_reacted') throw err; });

      const messages = await getThreadData(client, message.channel, threadTs);
      const channelName = await getChannelName(client, message.channel);
      const threadLink = `https://slack.com/archives/${message.channel}/p${threadTs.replace('.', '')}`;
      const mentionedBy = await getUserName(client, message.user);
      const replyCount = messages.length - 1;

      const lines = await Promise.all(
        messages.map(async (msg) => {
          const name = await getUserName(client, msg.user);
          return `*${name}:* ${msg.text}`;
        })
      );
      const threadContents = lines.join('\n');
      const timestamp = new Date().toISOString();

      await client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: `*@apollo-reliability was mentioned in ${channelName}* (<${threadLink}|View thread>)\n\n${threadContents}`,
      });

      const dmText = `*@apollo-reliability was mentioned in ${channelName}* by ${mentionedBy}\n<${threadLink}|View thread>`;
      for (const userId of DM_USERS) {
        await client.chat.postMessage({ channel: userId, text: dmText });
      }

      await appendToSheet('Apollo Reliability Mentions', [
        timestamp, channelName, mentionedBy, threadLink, threadContents, replyCount, '', 'Pending'
      ]);

      await db.query(
        'INSERT INTO mentions (channel_name, link, mentioned_by) VALUES ($1, $2, $3)',
        [channelName, threadLink, mentionedBy]
      );

      if (!pendingThreads.has(threadKey)) {
        const startTime = Date.now();
        const timer = setTimeout(async () => {
          try {
            const refreshed = await getThreadData(client, message.channel, threadTs);
            const groupMembers = await getGroupMembers(client);
            const replyMessages = refreshed.slice(1);
            const groupReply = replyMessages.find(m => groupMembers.includes(m.user));
            const gotResponse = !!groupReply;
            const responseTimeMins = gotResponse
              ? Math.round((parseFloat(groupReply.ts) * 1000 - startTime) / 60000)
              : null;

            if (!gotResponse) {
              await client.chat.postMessage({
                channel: FEEDBACK_CHANNEL,
                text: `:warning: *No response yet* — @apollo-reliability was mentioned in ${channelName} 4 hours ago with no reply from the group.\n<${threadLink}|View thread>`,
              });
            }

            const sheets = getSheetsClient();
            const sheetData = await sheets.spreadsheets.values.get({
              spreadsheetId: SHEET_ID,
              range: 'Apollo Reliability Mentions!A:D',
            });
            const rows = sheetData.data.values || [];
            const rowIndex = rows.findIndex(r => r[3] === threadLink);
            if (rowIndex > 0) {
              await sheets.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: `Apollo Reliability Mentions!G${rowIndex + 1}:H${rowIndex + 1}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[responseTimeMins ?? 'N/A', gotResponse ? 'Yes' : 'No']] },
              });
            }
          } catch (err) {
            logger.error('Error in response timer:', err);
          } finally {
            pendingThreads.delete(threadKey);
          }
        }, RESPONSE_WINDOW_MS);

        pendingThreads.set(threadKey, timer);
      }

    } catch (err) {
      logger.error('Error handling @apollo-reliability mention:', err);
    }
  }

  // --- @apollo mention (user tagging Apollo) ---
  if (isApolloMention) {
    try {
      const channelName = await getChannelName(client, message.channel);
      const threadLink = `https://slack.com/archives/${message.channel}/p${threadTs.replace('.', '')}`;
      const mentionedBy = await getUserName(client, message.user);
      const timestamp = new Date().toISOString();

      // Log to Apollo Mentions tab
      const messages = await getThreadData(client, message.channel, threadTs);
      await appendToSheet('Apollo Mentions', [
        timestamp, channelName, mentionedBy, threadLink, messages.length - 1
      ]);

      // Log this user message to Apollo Conversations tab + DB
      const threadId = threadKey;
      await appendToSheet('Apollo Conversations', [
        threadId, timestamp, channelName, mentionedBy, 'User', message.text, threadLink
      ]);
      await db.query(
        'INSERT INTO apollo_conversations (thread_id, channel_name, thread_link, speaker, role, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [threadId, channelName, threadLink, mentionedBy, 'User', message.text]
      );

    } catch (err) {
      logger.error('Error handling @apollo mention:', err);
    }
  }

  // Apollo's initial "..." placeholder — skip it, we'll capture the edited version instead
  if (isApolloReply && isReply) return;

  // --- Clear reliability timer if group member replies ---
  if (!isReliabilityMention && pendingThreads.has(threadKey)) {
    const groupMembers = await getGroupMembers(client);
    if (groupMembers.includes(message.user)) {
      clearTimeout(pendingThreads.get(threadKey));
      pendingThreads.delete(threadKey);
    }
  }
});

// --- Capture Apollo's real response when it edits its "..." placeholder ---
app.event('message', async ({ event, client, logger }) => {
  if (event.subtype !== 'message_changed') return;

  const msg = event.message;
  const isApolloReply = msg.user === APOLLO_BOT_USER_ID || (msg.bot_id && msg.username?.toLowerCase().includes('apollo'));
  if (!isApolloReply) return;
  if (!msg.thread_ts || msg.thread_ts === msg.ts) return;
  if (!msg.text || msg.text.trim() === '...') return;

  try {
    const threadTs = msg.thread_ts;
    const threadKey = `${event.channel}-${threadTs}`;
    const channelName = await getChannelName(client, event.channel);
    const threadLink = `https://slack.com/archives/${event.channel}/p${threadTs.replace('.', '')}`;
    const timestamp = new Date().toISOString();

    await appendToSheet('Apollo Conversations', [
      threadKey, timestamp, channelName, 'Apollo', 'Bot', msg.text, threadLink
    ]);
    await db.query(
      'INSERT INTO apollo_conversations (thread_id, channel_name, thread_link, speaker, role, message) VALUES ($1, $2, $3, $4, $5, $6)',
      [threadKey, channelName, threadLink, 'Apollo', 'Bot', msg.text]
    );
  } catch (err) {
    logger.error('Error capturing Apollo edited reply:', err);
  }
});

// Weekly digest — every Monday at 9:00 AM UTC
cron.schedule('0 9 * * 1', async () => {
  try {
    const result = await db.query(
      `SELECT channel_name, link, mentioned_by FROM mentions
       WHERE created_at >= NOW() - INTERVAL '7 days'
       ORDER BY created_at ASC`
    );
    const rows = result.rows;

    if (rows.length === 0) {
      await app.client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: ':white_check_mark: *Weekly Apollo Reliability Digest* — No mentions of @apollo-reliability this week.',
      });
    } else {
      const lines = rows.map(r => `• <${r.link}|Thread> in ${r.channel_name} — mentioned by ${r.mentioned_by}`);
      await app.client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: `:bar_chart: *Weekly Apollo Reliability Digest* — ${rows.length} mention(s) this week:\n\n${lines.join('\n')}`,
      });
    }

    await db.query(`DELETE FROM mentions WHERE created_at < NOW() - INTERVAL '7 days'`);
  } catch (err) {
    console.error('Error sending weekly digest:', err);
  }
});

(async () => {
  await setupDb();
  await ensureSheetTabs();
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Apollo Reliability Tracker running on port ${port}`);
})();
