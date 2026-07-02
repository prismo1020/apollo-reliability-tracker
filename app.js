const { App } = require('@slack/bolt');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const APOLLO_SUBTEAM_ID = 'S0B8C37C8RE';
const REACT_EMOJI = 'set-up';
const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL_ID; // set in Railway vars
const DM_USERS = ['U03PZ6EKVT2', 'U082FH8ER6G'];
const RESPONSE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

// In-memory timer tracking per thread
const pendingThreads = new Map();
// Weekly digest accumulator
const weeklyMentions = [];

// Cache user names to avoid hammering the API
const userCache = {};
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
    const res = await client.usergroups.users.list({ usergroup: APOLLO_SUBTEAM_ID });
    return res.users || [];
  } catch {
    return [];
  }
}

app.message(async ({ message, client, logger }) => {
  if (!message.thread_ts) return;

  const isMention = message.text?.includes(`<!subteam^${APOLLO_SUBTEAM_ID}`);
  const threadKey = `${message.channel}-${message.thread_ts}`;
  const isReply = message.thread_ts !== message.ts;

  // --- Handle @apollo-reliability mention in a thread reply ---
  if (isMention && isReply) {
    try {
      // 1. React to parent message
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.thread_ts,
        name: REACT_EMOJI,
      }).catch(err => {
        if (err.data?.error !== 'already_reacted') throw err;
      });

      // Fetch full thread
      const threadResult = await client.conversations.replies({
        channel: message.channel,
        ts: message.thread_ts,
      });
      const messages = threadResult.messages || [];

      // Format thread contents
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

      // 2. Post full thread recap to feedback channel
      await client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: `*@apollo-reliability was mentioned in ${channelName}* (<${threadLink}|View thread>)\n\n${lines.join('\n')}`,
      });

      // 3. DM Danielle and Kenneth
      const dmText = `*@apollo-reliability was mentioned in ${channelName}* by ${mentionedBy}\n<${threadLink}|View thread>`;
      for (const userId of DM_USERS) {
        await client.chat.postMessage({ channel: userId, text: dmText });
      }

      // 4. Start 4-hour response timer (only once per thread)
      if (!pendingThreads.has(threadKey)) {
        const timer = setTimeout(async () => {
          try {
            const refreshed = await client.conversations.replies({
              channel: message.channel,
              ts: message.thread_ts,
            });
            const groupMembers = await getGroupMembers(client);
            const hasGroupReply = (refreshed.messages || [])
              .slice(1) // skip parent
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

      // Track for weekly digest
      weeklyMentions.push({ channelName, link: threadLink, mentionedBy, ts: Date.now() });

    } catch (err) {
      logger.error('Error handling apollo-reliability mention:', err);
    }
  }

  // --- Clear timer if a group member replies in a tracked thread ---
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
    if (weeklyMentions.length === 0) {
      await app.client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: ':white_check_mark: *Weekly Apollo Reliability Digest* — No mentions of @apollo-reliability this week.',
      });
    } else {
      const lines = weeklyMentions.map(
        m => `• <${m.link}|Thread> in ${m.channelName} — mentioned by ${m.mentionedBy}`
      );
      await app.client.chat.postMessage({
        channel: FEEDBACK_CHANNEL,
        text: `:bar_chart: *Weekly Apollo Reliability Digest* — ${weeklyMentions.length} mention(s) this week:\n\n${lines.join('\n')}`,
      });
    }
    weeklyMentions.length = 0;
  } catch (err) {
    console.error('Error sending weekly digest:', err);
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Apollo Reliability Tracker running on port ${port}`);
})();
