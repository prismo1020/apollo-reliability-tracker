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

const CHANNEL_LOCATIONS = {
  'cus1002-topanga-uslaxtop': 'Topanga',
  'cus1003-sanmateo2-usbayhil': 'Hillsdale',
  'cus1004-sfpopup-usbaymkt': 'SF Market',
  'cus1005-missionvalley-ussdxmis': 'Mission Valley',
  'cus1006-cerritos-uslaxcer': 'Cerritos',
  'cus1007-oakbrook-uschioak': 'Oakbrook',
  'cus1008-domain-ustexdom': 'Domain',
  'cus1010-grandcanal-uslasgra': 'Grand Canal Vegas',
  'cus1011-sanramon-ussrcbis': 'Bishop Ranch',
  'cus1012-libertycenter-uscinlib': 'Liberty Center',
  'cus1013-rosedale-usminros': 'Rosedale',
  'cus1014-edenprairie-usminede': 'Eden Prairie',
  'cus1015-totemlake-uskirtot': 'Totem Lake',
  'cus1016-mockingbird-usdalmoc': 'Mockingbird',
  'cus1017-artisancircle-usforcro': 'Artisan Circle',
  'cus1018-baystreet-usemebay': 'Bay Street',
  'cus1019-interlock-usatlint': 'Interlock',
  'cus1020-crockerpark-uswescro': 'Crocker Park',
  'cus1021-bottleworks-usindbot': 'Bottleworks',
  'cus1022-bridgepark-usdubbri': 'Bridge Park',
  'cus1023-borotysons-ustysbor': 'Boro Tysons',
  'cus1025-therim-ussanrim': 'The Rim',
  'cus1029-parkmeadows-uslonpar': 'Park Meadows',
  'cus1030-leawood-uslealea': 'Leawood',
  'cus1032-miraclemile-uslasmir': 'Miracle Mile',
  'cus1033-oxmoor-uslouoxm': 'Oxmoor',
  'cus1034-fashionplace-usmurfas': 'Fashion Place',
  'cus1035-cityfoundry-usstlcit': 'City Foundry',
  'cus1036-southlakeunion-usseawes': 'South Lake Union',
  'cus1038-terminal-uspitter': 'Terminal',
  'cus1040-lincolncommons-uschilin': 'Lincoln Commons',
  'cus1047-cumulus-uslaxcul': 'Cumulus',
  'cus1049-thebattery-usatlbat': 'The Battery',
  'ccn1009-sh-centralplaza-cnshacen': 'Shanghai Central Plaza',
  'chk1001-tsimshatsui-hktstcam': 'Tsim Sha Tsui',
  'chk1026-hkmidtown-hkcwbmid': 'HK Midtown',
  'csg1044-singapore-sgsinorc': 'Singapore',
};

const pendingThreads = new Map();
const apolloEditDebounce = new Map();
const userCache = {};

// --- Timestamp helper (CST/CDT) ---
function nowCST() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// --- Location helper ---
function getLocation(channelName) {
  return CHANNEL_LOCATIONS[channelName] || null;
}

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
  const tabs = ['Apollo Reliability Mentions', 'Apollo Mentions', 'Apollo Conversations', 'Apollo Feedback'];
  for (const tab of tabs) {
    if (!existingTitles.includes(tab)) {
      requests.push({ addSheet: { properties: { title: tab } } });
    }
  }
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  }

  const tabHeaders = [
    ['Apollo Reliability Mentions', ['Timestamp', 'Channel', 'Location', 'Mentioned By', 'Thread Link', 'Thread Contents', '# of Replies', 'Response Time (mins)', 'Got Response?']],
    ['Apollo Mentions', ['Timestamp', 'Channel', 'Location', 'Mentioned By', 'Thread Link', '# of Replies']],
    ['Apollo Conversations', ['Thread ID', 'Timestamp', 'Channel', 'Location', 'Speaker', 'Role', 'Message', 'Thread Link']],
    ['Apollo Feedback', ['Timestamp', 'Channel', 'Location', 'Reaction', 'Apollo Message', 'Thread Link', 'Reacted By']],
  ];

  for (const [tab, headers] of tabHeaders) {
    const check = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1` });
    if (!check.data.values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
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
      location TEXT,
      link TEXT,
      mentioned_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS apollo_conversations (
      id SERIAL PRIMARY KEY,
      thread_id TEXT,
      channel_name TEXT,
      location TEXT,
      thread_link TEXT,
      speaker TEXT,
      role TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS apollo_feedback (
      id SERIAL PRIMARY KEY,
      channel_name TEXT,
      location TEXT,
      reaction TEXT,
      apollo_message TEXT,
      thread_link TEXT,
      reacted_by TEXT,
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
    return res.channel?.name || channel;
  } catch {
    return channel;
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
  const isApolloReply = message.user === APOLLO_BOT_USER_ID || (message.bot_id && message.username?.toLowerCase().includes('apollo'));

  const rawChannelName = await getChannelName(client, message.channel);
  const channelName = `#${rawChannelName}`;
  const location = getLocation(rawChannelName) || 'Unknown';
  const threadLink = `https://slack.com/archives/${message.channel}/p${threadTs.replace('.', '')}`;
  const timestamp = nowCST();

  // --- @apollo-reliability mention ---
  if (isReliabilityMention) {
    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: threadTs,
        name: REACT_EMOJI,
      }).catch(err => { if (err.data?.error !== 'already_reacted') throw err; });

      const messages = await getThreadData(client, message.channel, threadTs);
      const mentionedBy = await getUserName(client, message.user);
      const replyCount = messages.length - 1;

      const lines = await Promise.all(
        messages.map(async (msg) => {
          const name = await getUserName(client, msg.user);
          return `*${name}:* ${msg.text}`;
        })
      );
      const threadContents = lines.join('\n');

      await client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: `*@apollo-reliability was mentioned in ${channelName}* (<${threadLink}|View thread>)\n\n${threadContents}`,
      });

      const dmText = `*@apollo-reliability was mentioned in ${channelName}* by ${mentionedBy}\n<${threadLink}|View thread>`;
      for (const userId of DM_USERS) {
        await client.chat.postMessage({ channel: userId, text: dmText });
      }

      await appendToSheet('Apollo Reliability Mentions', [
        timestamp, channelName, location, mentionedBy, threadLink, threadContents, replyCount, '', 'Pending'
      ]);

      await db.query(
        'INSERT INTO mentions (channel_name, location, link, mentioned_by) VALUES ($1, $2, $3, $4)',
        [channelName, location, threadLink, mentionedBy]
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
              range: 'Apollo Reliability Mentions!A:E',
            });
            const rows = sheetData.data.values || [];
            const rowIndex = rows.findIndex(r => r[4] === threadLink);
            if (rowIndex > 0) {
              await sheets.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: `Apollo Reliability Mentions!H${rowIndex + 1}:I${rowIndex + 1}`,
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
      const mentionedBy = await getUserName(client, message.user);
      const messages = await getThreadData(client, message.channel, threadTs);

      // React with a logged emoji so users know it was captured
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'eyes',
      }).catch(err => { if (err.data?.error !== 'already_reacted') throw err; });

      await appendToSheet('Apollo Mentions', [
        timestamp, channelName, location, mentionedBy, threadLink, messages.length - 1
      ]);

      await appendToSheet('Apollo Conversations', [
        threadKey, timestamp, channelName, location, mentionedBy, 'User', message.text, threadLink
      ]);
      await db.query(
        'INSERT INTO apollo_conversations (thread_id, channel_name, location, thread_link, speaker, role, message) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [threadKey, channelName, location, threadLink, mentionedBy, 'User', message.text]
      );
    } catch (err) {
      logger.error('Error handling @apollo mention:', err);
    }
  }

  // Apollo's initial placeholder — skip, capture on message_changed instead
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

// --- Capture Apollo's final response (debounced) ---
app.event('message', async ({ event, client, logger }) => {
  if (event.subtype !== 'message_changed') return;

  const msg = event.message;
  const isApolloReply = msg.user === APOLLO_BOT_USER_ID || (msg.bot_id && msg.username?.toLowerCase().includes('apollo'));
  if (!isApolloReply) return;
  if (!msg.thread_ts || msg.thread_ts === msg.ts) return;
  if (!msg.text || msg.text.trim() === '...') return;

  const debounceKey = `${event.channel}-${msg.ts}`;
  if (apolloEditDebounce.has(debounceKey)) clearTimeout(apolloEditDebounce.get(debounceKey));

  apolloEditDebounce.set(debounceKey, setTimeout(async () => {
    apolloEditDebounce.delete(debounceKey);
    try {
      const rawChannelName = await getChannelName(client, event.channel);
      const channelName = `#${rawChannelName}`;
      const location = getLocation(rawChannelName) || 'Unknown';
      const threadTs = msg.thread_ts;
      const threadKey = `${event.channel}-${threadTs}`;
      const threadLink = `https://slack.com/archives/${event.channel}/p${threadTs.replace('.', '')}`;
      const timestamp = nowCST();

      await appendToSheet('Apollo Conversations', [
        threadKey, timestamp, channelName, location, 'Apollo', 'Bot', msg.text, threadLink
      ]);
      await db.query(
        'INSERT INTO apollo_conversations (thread_id, channel_name, location, thread_link, speaker, role, message) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [threadKey, channelName, location, threadLink, 'Apollo', 'Bot', msg.text]
      );
    } catch (err) {
      logger.error('Error capturing Apollo final reply:', err);
    }
  }, 5000));
});

// --- Thumbs up/down reaction logging ---
async function handleReaction(event, client, logger, isAdded) {
  if (!['thumbsup', 'thumbsdown', '+1', '-1'].includes(event.reaction)) return;
  if (!event.item_user || event.item_user !== APOLLO_BOT_USER_ID) return;

  try {
    const channel = event.item.channel;
    const messageTs = event.item.ts;
    const rawChannelName = await getChannelName(client, channel);
    const channelName = `#${rawChannelName}`;
    const location = getLocation(rawChannelName) || 'Unknown';
    const threadTs = event.item.ts;
    const threadLink = `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;
    const reactionLabel = ['thumbsup', '+1'].includes(event.reaction) ? '👍 Helpful' : '👎 Not Helpful';
    const reactedBy = await getUserName(client, event.user);
    const timestamp = nowCST();

    // Fetch the Apollo message that was reacted to
    let apolloMessage = '';
    try {
      const history = await client.conversations.replies({ channel, ts: messageTs });
      const msg = (history.messages || []).find(m => m.ts === messageTs);
      apolloMessage = msg?.text || '';
    } catch {}

    await appendToSheet('Apollo Feedback', [
      timestamp, channelName, location, reactionLabel, apolloMessage, threadLink, reactedBy
    ]);
    await db.query(
      'INSERT INTO apollo_feedback (channel_name, location, reaction, apollo_message, thread_link, reacted_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [channelName, location, reactionLabel, apolloMessage, threadLink, reactedBy]
    );
  } catch (err) {
    logger.error('Error logging reaction:', err);
  }
}

app.event('reaction_added', async ({ event, client, logger }) => {
  await handleReaction(event, client, logger, true);
});

// --- /apollo-stats slash command ---
app.command('/apollo-stats', async ({ command, ack, client, logger }) => {
  await ack();
  try {
    const [mentionRows, convoRows, feedbackRows] = await Promise.all([
      db.query(`SELECT channel_name, location, mentioned_by FROM mentions WHERE created_at >= NOW() - INTERVAL '7 days'`),
      db.query(`SELECT DISTINCT thread_id, location FROM apollo_conversations WHERE created_at >= NOW() - INTERVAL '7 days' AND role = 'User'`),
      db.query(`SELECT reaction, COUNT(*) as count FROM apollo_feedback WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY reaction`),
    ]);

    const totalMentions = mentionRows.rows.length;
    const totalConvos = convoRows.rows.length;

    const locationCounts = {};
    convoRows.rows.forEach(r => {
      locationCounts[r.location] = (locationCounts[r.location] || 0) + 1;
    });
    const topLocation = Object.entries(locationCounts).sort((a, b) => b[1] - a[1])[0];

    const thumbsUp = feedbackRows.rows.find(r => r.reaction === '👍 Helpful')?.count || 0;
    const thumbsDown = feedbackRows.rows.find(r => r.reaction === '👎 Not Helpful')?.count || 0;

    await client.chat.postMessage({
      channel: command.channel_id,
      text: `:bar_chart: *Apollo Stats — Last 7 Days*\n\n• *@apollo-reliability mentions:* ${totalMentions}\n• *@Apollo conversations:* ${totalConvos}\n• *Top location:* ${topLocation ? `${topLocation[0]} (${topLocation[1]} convos)` : 'N/A'}\n• *👍 Helpful reactions:* ${thumbsUp}\n• *👎 Not helpful reactions:* ${thumbsDown}`,
    });
  } catch (err) {
    logger.error('Error in /apollo-stats:', err);
  }
});

// --- Weekly digest — Mondays at 10am CST (16:00 UTC in CDT) ---
cron.schedule('0 15 * * 1', async () => {
  try {
    const [mentionRows, convoRows, feedbackRows, topQRows] = await Promise.all([
      db.query(`SELECT channel_name, location, link, mentioned_by FROM mentions WHERE created_at >= NOW() - INTERVAL '7 days' ORDER BY created_at ASC`),
      db.query(`SELECT DISTINCT thread_id, location FROM apollo_conversations WHERE created_at >= NOW() - INTERVAL '7 days' AND role = 'User'`),
      db.query(`SELECT reaction, COUNT(*) as count FROM apollo_feedback WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY reaction`),
      db.query(`SELECT message, COUNT(*) as count FROM apollo_conversations WHERE created_at >= NOW() - INTERVAL '7 days' AND role = 'User' GROUP BY message ORDER BY count DESC LIMIT 5`),
    ]);

    const totalMentions = mentionRows.rows.length;
    const totalConvos = convoRows.rows.length;
    const thumbsUp = feedbackRows.rows.find(r => r.reaction === '👍 Helpful')?.count || 0;
    const thumbsDown = feedbackRows.rows.find(r => r.reaction === '👎 Not Helpful')?.count || 0;

    const locationCounts = {};
    convoRows.rows.forEach(r => {
      locationCounts[r.location] = (locationCounts[r.location] || 0) + 1;
    });
    const topLocations = Object.entries(locationCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const topLocationText = topLocations.map(([loc, count]) => `${loc} (${count})`).join(', ');

    const topQText = topQRows.rows.length
      ? topQRows.rows.map((r, i) => `${i + 1}. "${r.message.slice(0, 80)}${r.message.length > 80 ? '...' : ''}" _(${r.count}x)_`).join('\n')
      : 'No data yet';

    const reliabilityLinks = mentionRows.rows.map(r => `• <${r.link}|Thread> — ${r.location} — by ${r.mentioned_by}`).join('\n') || 'None this week';

    const text = [
      `:bar_chart: *Weekly Apollo Digest*\n`,
      `*@apollo-reliability Mentions:* ${totalMentions}`,
      `*@Apollo Conversations:* ${totalConvos}`,
      `*Top Locations:* ${topLocationText || 'N/A'}`,
      `*Feedback:* 👍 ${thumbsUp} helpful · 👎 ${thumbsDown} not helpful\n`,
      `*Top Questions This Week:*\n${topQText}\n`,
      `*@apollo-reliability Threads:*\n${reliabilityLinks}`,
    ].join('\n');

    await app.client.chat.postMessage({ channel: FEEDBACK_CHANNEL, text });
    await db.query(`DELETE FROM mentions WHERE created_at < NOW() - INTERVAL '7 days'`);
  } catch (err) {
    console.error('Error sending weekly digest:', err);
  }
});

// --- Monthly report — 1st of each month at 10am CST ---
cron.schedule('0 15 1 * *', async () => {
  try {
    const [convoRows, feedbackRows, locationRows] = await Promise.all([
      db.query(`SELECT DATE_TRUNC('week', created_at) as week, COUNT(DISTINCT thread_id) as convos FROM apollo_conversations WHERE role = 'User' AND created_at >= NOW() - INTERVAL '30 days' GROUP BY week ORDER BY week`),
      db.query(`SELECT reaction, COUNT(*) as count FROM apollo_feedback WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY reaction`),
      db.query(`SELECT location, COUNT(DISTINCT thread_id) as convos FROM apollo_conversations WHERE role = 'User' AND created_at >= NOW() - INTERVAL '30 days' GROUP BY location ORDER BY convos DESC LIMIT 5`),
    ]);

    const thumbsUp = feedbackRows.rows.find(r => r.reaction === '👍 Helpful')?.count || 0;
    const thumbsDown = feedbackRows.rows.find(r => r.reaction === '👎 Not Helpful')?.count || 0;
    const totalConvos = convoRows.rows.reduce((sum, r) => sum + parseInt(r.convos), 0);

    const weeklyBreakdown = convoRows.rows.map(r => {
      const weekOf = new Date(r.week).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
      return `• Week of ${weekOf}: ${r.convos} conversations`;
    }).join('\n') || 'No data';

    const topLocations = locationRows.rows.map((r, i) => `${i + 1}. ${r.location} — ${r.convos} conversations`).join('\n') || 'No data';

    const satisfactionRate = (thumbsUp + thumbsDown) > 0
      ? `${Math.round((thumbsUp / (thumbsUp + thumbsDown)) * 100)}%`
      : 'No feedback yet';

    const text = [
      `:calendar: *Monthly Apollo Report*\n`,
      `*Total Conversations (30 days):* ${totalConvos}`,
      `*Satisfaction Rate:* ${satisfactionRate} (👍 ${thumbsUp} · 👎 ${thumbsDown})\n`,
      `*Top 5 Locations by Usage:*\n${topLocations}\n`,
      `*Weekly Breakdown:*\n${weeklyBreakdown}`,
    ].join('\n');

    await app.client.chat.postMessage({ channel: FEEDBACK_CHANNEL, text });
  } catch (err) {
    console.error('Error sending monthly report:', err);
  }
});

(async () => {
  await setupDb();
  await ensureSheetTabs();
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Apollo Reliability Tracker running on port ${port}`);
})();
