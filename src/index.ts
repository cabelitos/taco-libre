import process from 'process';
import { createConnection, getConnection } from 'typeorm';
import express from 'express';
import { createEventAdapter } from '@slack/events-api';
import { WebClient } from '@slack/web-api';

import Leaderboard, { InsertLeaderboardData } from './entities/Leaderboard';

import installerProvider from './install-provider';

interface Command {
  handler: (
    channel: string,
    threadId: string | undefined,
    team: string,
  ) => Promise<void>;
  keyword: string;
}

interface SlackMessage {
  client_msg_id: string;
  team: string;
  text: string;
}

const getLeaderboardLimit = (): number => {
  const limit = parseInt(process.env.LEADERBOARD_LIMIT ?? '10', 10) ?? 10;
  return Number.isNaN(limit) ? 10 : limit;
};

const emojiRegExp = /(:[\w-]+:)/gi;
const peopleRegex = /<@(.+?)>/g;

const startRtmService = async (): Promise<void> => {
  await createConnection();

  const app = express();
  const slackEvents = createEventAdapter(process.env.SLACK_SIGN_SECRET ?? '');
  const slackEventListener = slackEvents.requestListener();

  const databaseCheck = async (): Promise<void> => {
    const conn = getConnection();
    if (!conn.isConnected) {
      throw new Error('Not connected with the database');
    }
    await conn.query('select 1');
  };

  app.get('/.well-known/server-health', async (_, reply) => {
    try {
      await databaseCheck();
    } catch (err) {
      reply.status(500).send({ error: err.message, status: 'fail' });
      return;
    }
    reply.status(200).send({ status: 'ok' });
  });

  app.post('/slack/events', slackEventListener);

  app.get('/', async (_, res) => {
    try {
      const url = await installerProvider.generateInstallUrl({
        scopes: ['app_mentions:read', 'channels:history', 'chat:write'],
      });
      res.send(
        `<a href=${url}><img alt=""Add to Slack"" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>`,
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(error);
    }
  });

  app.get('/slack/oauth_redirect', async (req, res) => {
    await installerProvider.handleCallback(req, res);
  });

  const leaderboardLimit = getLeaderboardLimit();

  const sendMessage = async (
    text: string,
    channel: string,
    threadId: string | undefined,
    teamId: string,
  ): Promise<void> => {
    const { botToken } = await installerProvider.authorize({
      enterpriseId: '',
      isEnterpriseInstall: false,
      teamId,
    });
    const web = new WebClient(botToken);
    await web.chat.postMessage({
      channel,
      text,
      thread_ts: threadId,
    });
  };

  const commands: Command[] = [
    {
      handler: async (
        channel: string,
        threadId: string | undefined,
        team: string,
      ): Promise<void> => {
        const data = await Leaderboard.getLeaderboard(leaderboardLimit, team);
        if (!data.length) {
          await sendMessage(
            'Leaderboard is empty. Starting sending recognitions! :taco: :burrito:',
            channel,
            threadId,
            team,
          );
          return;
        }
        let text = '';
        data.forEach(({ awardCount, userId }, i): void => {
          text += `${i + 1}) <@${userId}> - ${awardCount} ${
            awardCount === '1' ? 'recognition' : 'recognitions'
          }\n`;
        });
        await sendMessage(text, channel, threadId, team);
      },
      keyword: 'leaderboard',
    },
  ];

  const prepareMessageContext = (
    subtype: string | undefined,
    originalText: string | undefined,
    originalMessageId: string | undefined,
    message: SlackMessage,
    prevMessage: SlackMessage,
    teamId: string | undefined,
  ): Record<
    'textToUse' | 'messageIdToDelete' | 'messageIdToUse' | 'teamIdToUse',
    string
  > => {
    let textToUse = originalText;
    let messageIdToUse = originalMessageId;
    let messageIdToDelete;
    let teamIdToUse = teamId;
    if (subtype === 'message_changed') {
      textToUse = message.text;
      messageIdToUse = message.client_msg_id;
      messageIdToDelete = prevMessage.client_msg_id;
      teamIdToUse = prevMessage.team;
    } else if (subtype === 'message_deleted') {
      textToUse = prevMessage.text;
      messageIdToDelete = prevMessage.client_msg_id;
      teamIdToUse = prevMessage.team;
    }
    return {
      messageIdToDelete: messageIdToDelete ?? '',
      messageIdToUse: messageIdToUse ?? '',
      teamIdToUse: teamIdToUse ?? '',
      textToUse: textToUse ?? '',
    };
  };

  const getMentionedPeople = (text: string): RegExpMatchArray[] =>
    Array.from(text.matchAll(peopleRegex) ?? []);

  slackEvents.on(
    'app_mention',
    async ({ text, channel, thread_ts: threadId, team }): Promise<void> => {
      try {
        const people = getMentionedPeople(text);
        if (people.length !== 1) return;
        const botId = people[0][1];
        for (let i = 0; i < commands.length; i += 1) {
          const { handler, keyword } = commands[i];
          if (
            text.match(new RegExp(`^\\s*<@${botId}>\\s+${keyword}\\s*$`, 'i'))
          ) {
            // eslint-disable-next-line no-await-in-loop
            await handler(channel, threadId, team);
            return;
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
      }
    },
  );

  slackEvents.on(
    'message',
    async ({
      text,
      subtype,
      client_msg_id: messageId,
      previous_message: prevMessage,
      message,
      team: teamId,
    }): Promise<void> => {
      try {
        const {
          messageIdToUse,
          messageIdToDelete,
          textToUse,
          teamIdToUse,
        } = prepareMessageContext(
          subtype,
          text,
          messageId,
          message,
          prevMessage,
          teamId,
        );
        const emojisMatch = textToUse.match(emojiRegExp);
        const people = getMentionedPeople(textToUse);
        if (!people) return;
        if (subtype === 'message_deleted' && messageIdToDelete && emojisMatch) {
          await Leaderboard.deleteAwards(messageIdToDelete, teamIdToUse);
          return;
        }

        if (!emojisMatch) return;

        const emojiToSave = people.reduce(
          (
            acc: Record<string, InsertLeaderboardData[]>,
            match: RegExpMatchArray,
          ): Record<string, InsertLeaderboardData[]> => {
            const userId = match[1];
            if (!acc[userId]) {
              acc[userId] = emojisMatch.map(emoji => ({
                emoji,
                messageId: messageIdToUse,
                teamId: teamIdToUse,
                userId,
              }));
            }
            return acc;
          },
          {},
        );
        await Leaderboard.addAwards(
          Object.values(emojiToSave).flat(),
          messageIdToDelete,
          teamIdToUse,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    try {
      app.listen(
        parseInt(process.env.SERVER_PORT ?? '3000', 10) ?? 3000,
        process.env.SERVER_HOST ?? 'localhost',
        resolve,
      );
    } catch (err) {
      reject(err);
    }
  });
};

Promise.all([startRtmService()]).catch((err): void => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
