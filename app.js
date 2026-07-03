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

// --- Google Sheets setup ---
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

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  }

  // Add headers if sheets are new
  const reliabilityHeaders = [['Timestamp', 'Channel', 'Mentioned By', 'Thread Link', 'Thread Contents', '# of Replies', 'Response Time (mins)', 'Got Response?']];
  const apolloHeaders = [['Timestamp', 'Channel', 'Mentioned By', 'Thread Link', '# of Replies']];

  for (const [tab, headers] of [['Apollo Reliability Mentions', reliabilityHeaders], ['Apollo Mentions', apolloHeaders]]) {
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

async function appendToSheet(tab, row) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// --- DB setup ---
async function setupDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mentions (
      id SERIAL PRIMARY KEY,
      channel_name TEXT,
      link TEXT,
      mentioned_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
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
  if (!message.thread_ts || !message.text) return;

  const isReply = message.thread_ts !== message.ts;
  if (!isReply) return;

  const isReliabilityMention = message.text.includes(`<!subteam^${APOLLO_RELIABILITY_SUBTEAM_ID}`);
  const isApolloMention = message.text.includes(`<@${APOLLO_BOT_USER_ID}>`);
  const threadKey = `${message.channel}-${message.thread_ts}`;

  // --- @apollo-reliability mention ---
  if (isReliabilityMention) {
    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.thread_ts,
        name: REACT_EMOJI,
      }).catch(err => { if (err.data?.error !== 'already_reacted') throw err; });

      const messages = await getThreadData(client, message.channel, message.thread_ts);
      const channelName = await getChannelName(client, message.channel);
      const threadLink = `https://slack.com/archives/${message.channel}/p${message.thread_ts.replace('.', '')}`;
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

      // Post thread recap to feedback channel
      await client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: `*@apollo-reliability was mentioned in ${channelName}* (<${threadLink}|View thread>)\n\n${threadContents}`,
      });

      // DM Danielle and Kenneth
      const dmText = `*@apollo-reliability was mentioned in ${channelName}* by ${mentionedBy}\n<${threadLink}|View thread>`;
      for (const userId of DM_USERS) {
        await client.chat.postMessage({ channel: userId, text: dmText });
      }

      // Log to Google Sheet (response time and got response filled in later)
      await appendToSheet('Apollo Reliability Mentions', [
        timestamp, channelName, mentionedBy, threadLink, threadContents, replyCount, '', 'Pending'
      ]);

      // Store for weekly digest
      await db.query(
        'INSERT INTO mentions (channel_name, link, mentioned_by) VALUES ($1, $2, $3)',
        [channelName, threadLink, mentionedBy]
      );

      // Start 4-hour response timer
      if (!pendingThreads.has(threadKey)) {
        const startTime = Date.now();
        const timer = setTimeout(async () => {
          try {
            const refreshed = await getThreadData(client, message.channel, message.thread_ts);
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

            // Update sheet row — find and update the matching row
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

  // --- @apollo mention ---
  if (isApolloMention) {
    try {
      const messages = await getThreadData(client, message.channel, message.thread_ts);
      const channelName = await getChannelName(client, message.channel);
      const threadLink = `https://slack.com/archives/${message.channel}/p${message.thread_ts.replace('.', '')}`;
      const mentionedBy = await getUserName(client, message.user);
      const replyCount = messages.length - 1;
      const timestamp = new Date().toISOString();

      await appendToSheet('Apollo Mentions', [
        timestamp, channelName, mentionedBy, threadLink, replyCount
      ]);
    } catch (err) {
      logger.error('Error handling @apollo mention:', err);
    }
  }

  // --- Clear reliability timer if group member replies ---
  if (!isReliabilityMention && pendingThreads.has(threadKey)) {
    const groupMembers = await getGroupMembers(client);
    if (groupMembers.includes(message.user)) {
      clearTimeout(pendingThreads.get(threadKey));
      pendingThreads.delete(threadKey);
    }
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
