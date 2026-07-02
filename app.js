const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const APOLLO_RELIABILITY_SUBTEAM_ID = 'S0B8C37C8RE';
const REACT_EMOJI = 'set-up';

app.message(async ({ message, client, logger }) => {
  // Only handle thread replies that mention the subteam
  if (!message.thread_ts || message.thread_ts === message.ts) return;
  if (!message.text || !message.text.includes(`<!subteam^${APOLLO_RELIABILITY_SUBTEAM_ID}`)) return;

  try {
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.thread_ts,
      name: REACT_EMOJI,
    });
    logger.info(`Reacted to parent message ${message.thread_ts} in channel ${message.channel}`);
  } catch (err) {
    // already_reacted is fine — ignore it, log everything else
    if (err.data?.error !== 'already_reacted') {
      logger.error('Failed to add reaction:', err);
    }
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Apollo Reliability Tracker running on port ${port}`);
})();
