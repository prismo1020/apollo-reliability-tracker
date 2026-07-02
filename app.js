const { App } = require('@slack/bolt');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APOLLO_SUBTEAM_ID = 'S0B8C37C8RE';
const REACT_EMOJI = 'set-up';
const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL_ID;
const DM_USERS = ['U03PZ6EKVT2', 'U082FH8ER6G'];
const RESPONSE_WINDOW_MS = 4 * 60 * 60 * 1000;

const pendingThreads = new Map();
const userCache = {};

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

async function getUserName(client, userId) {
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
    const group = (res.usergroups || []).find(g => g.id === APOLLO_SUBTEAM_ID);
    return group?.users || [];
  } catch {
    return [];
  }
}

app.message(async ({ message, client, logger }) => {
  if (!message.thread_ts) return;

  const isMention = message.text?.includes(`<!subteam^${APOLLO_SUBTEAM_ID}`);
  const threadKey = `${message.channel}-${message.thread_ts}`;
  const isReply = message.thread_ts !== message.ts;

  if (isMention && isReply) {
    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.thread_ts,
        name: REACT_EMOJI,
      }).catch(err => {
        if (err.data?.error !== 'already_reacted') throw err;
      });

      const threadResult = await client.conversations.replies({
        channel: message.channel,
        ts: message.thread_ts,
      });
      const messages = threadResult.messages || [];

      const lines = await Promise.all(
        messages.map(async (msg) => {
          const name = await getUserName(client, msg.user);
          return `*${name}:* ${msg.text}`;
        })
      );

      const channelInfo = await client.conversations.info({ channel: message.channel }).catch(() => null);
      const channelName = channelInfo?.channel?.name ? `#${channelInfo.channel.name}` : 'a channel';
      const threadLink = `https://slack.com/archives/${message.channel}/p${message.thread_ts.replace('.', '')}`;
      const mentionedBy = await getUserName(client, message.user);

      await client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: `*@apollo-reliability was mentioned in ${channelName}* (<${threadLink}|View thread>)\n\n${lines.join('\n')}`,
      });

      const dmText = `*@apollo-reliability was mentioned in ${channelName}* by ${mentionedBy}\n<${threadLink}|View thread>`;
      for (const userId of DM_USERS) {
        await client.chat.postMessage({ channel: userId, text: dmText });
      }

      if (!pendingThreads.has(threadKey)) {
        const timer = setTimeout(async () => {
          try {
            const refreshed = await client.conversations.replies({
              channel: message.channel,
              ts: message.thread_ts,
            });
            const groupMembers = await getGroupMembers(client);
            const hasGroupReply = (refreshed.messages || [])
              .slice(1)
              .some(m => groupMembers.includes(m.user));

            if (!hasGroupReply) {
              await client.chat.postMessage({
                channel: FEEDBACK_CHANNEL,
                text: `:warning: *No response yet* — @apollo-reliability was mentioned in ${channelName} 4 hours ago and no one from the group has replied.\n<${threadLink}|View thread>`,
              });
            }
          } catch (err) {
            logger.error('Error in response timer check:', err);
          } finally {
            pendingThreads.delete(threadKey);
          }
        }, RESPONSE_WINDOW_MS);

        pendingThreads.set(threadKey, timer);
      }

      // Persist mention to DB for weekly digest
      await db.query(
        'INSERT INTO mentions (channel_name, link, mentioned_by) VALUES ($1, $2, $3)',
        [channelName, threadLink, mentionedBy]
      );

    } catch (err) {
      logger.error('Error handling apollo-reliability mention:', err);
    }
  }

  if (isReply && pendingThreads.has(threadKey) && !isMention) {
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

    // Clear sent mentions
    await db.query(`DELETE FROM mentions WHERE created_at < NOW() - INTERVAL '7 days'`);
  } catch (err) {
    console.error('Error sending weekly digest:', err);
  }
});

(async () => {
  await setupDb();
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Apollo Reliability Tracker running on port ${port}`);
})();
