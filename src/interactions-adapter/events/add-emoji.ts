import type { KnownBlock } from '@slack/web-api';

import PendingLeaderboardContent from '../../entities/PendingLeaderbordContent';
import DoNotAskForAddEmojis from '../../entities/DoNotAskForAddEmojis';
import type { InteractionResponseHandler } from '../../utils/types';

const separator = '_';
const addEmojiEventPrefix = `addEmoji`;
const doNotAskEventAction = 'doNotAskMe';

export const addEmojiEventAction = {
  actionId: new RegExp(
    `${addEmojiEventPrefix}${separator}(.+)|^${doNotAskEventAction}${separator}(.+)$`,
  ),
};

interface EventBody {
  actions: { action_id: string; value: string; selected_options?: unknown[] }[];
  channel: { id: string };
  team: { id: string };
  user: { id: string };
}

const createEmojiActionId = (
  threadId: string | null,
  messageId: string,
  reactionId: string | null,
  isPrimary: boolean,
): string =>
  `${addEmojiEventPrefix}${separator}${threadId || 'null'}${separator}${
    reactionId || 'null'
  }${separator}${messageId}${separator}${isPrimary ? '1' : '0'}`;

const createDoNotAskForEmojisActionId = (threadId: string | null): string =>
  `${doNotAskEventAction}${separator}${threadId || 'null'}`;

export const createAddEmojiInteractions = (
  threadId: string | null,
  messageId: string,
  reactionId: string | null,
  pluralIt: string,
): KnownBlock[] => [
  {
    elements: [
      {
        action_id: createEmojiActionId(threadId, messageId, reactionId, true),
        style: 'primary',
        text: {
          emoji: true,
          text: `Please, add ${pluralIt}!`,
          type: 'plain_text',
        },
        type: 'button',
        value: '1',
      },
      {
        action_id: createEmojiActionId(threadId, messageId, reactionId, false),
        style: 'danger',
        text: {
          emoji: true,
          text: `Ignore ${pluralIt}!`,
          type: 'plain_text',
        },
        type: 'button',
        value: '0',
      },
      {
        action_id: createDoNotAskForEmojisActionId(threadId),
        options: [
          {
            text: {
              text: 'Please, stop asking me.',
              type: 'plain_text',
            },
          },
        ],
        type: 'checkboxes',
      },
    ],
    type: 'actions',
  },
];

const handleAddEmojiEvent = async (
  msgId: string,
  channelId: string,
  teamId: string,
  reactionId: string | undefined,
  threadId: string | undefined,
  value: string,
  response: InteractionResponseHandler,
): Promise<void> => {
  let text = '>Ok, not adding as award :crying_cat_face:.';
  if (value === '1') {
    text = '>Great, the award was added :tada:!';
    await PendingLeaderboardContent.commitAwards(
      msgId,
      teamId,
      channelId,
      reactionId,
    );
  } else {
    await PendingLeaderboardContent.deleteAwards(
      msgId,
      teamId,
      channelId,
      reactionId,
    );
  }
  response({
    replace_original: true,
    response_type: 'ephemeral',
    text,
    thread_ts: threadId,
  });
};

const handleDoNotAskEvent = (
  teamId: string,
  userId: string,
  selectedOptions: unknown[] | undefined | null,
  _response: InteractionResponseHandler,
): Promise<unknown> => {
  return !selectedOptions?.length
    ? DoNotAskForAddEmojis.deleteDoNotAskForEmojis(teamId, userId)
    : DoNotAskForAddEmojis.addDoNotAskForEmojis(teamId, userId);
};

const eventHandler = (
  {
    actions: [
      { action_id: actionId, value, selected_options: selectedOptions },
    ],
    channel: { id: channelId },
    team: { id: teamId },
    user: { id: userId },
  }: EventBody,
  response: InteractionResponseHandler,
): void => {
  let operation: Promise<unknown>;
  const [actionName, threadId, reactionId, msgId] = actionId.split('_');
  let finalThreadId: undefined | string;
  if (actionName === doNotAskEventAction) {
    operation = handleDoNotAskEvent(teamId, userId, selectedOptions, response);
    finalThreadId = undefined;
  } else {
    finalThreadId = threadId === 'null' ? undefined : threadId;
    const finalReactionId = reactionId === 'null' ? undefined : reactionId;
    /*
   Slack recommends that interaction handlers do should not return ANY value from handlers when using block messages.
   In this case, the handler entry point should not be an async function, which would make it to implicitly return
   a Promise.
  */
    operation = handleAddEmojiEvent(
      msgId,
      channelId,
      teamId,
      finalReactionId,
      finalThreadId,
      value,
      response,
    );
  }
  operation.catch(err => {
    // eslint-disable-next-line no-console
    console.error(err);
    response({
      replace_original: true,
      response_type: 'ephemeral',
      text: 'Oops, could not perform the operation :crying_cat_face:.',
      thread_ts: finalThreadId,
    });
  });
};

export default eventHandler;
