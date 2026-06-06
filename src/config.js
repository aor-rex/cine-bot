import 'dotenv/config';

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  ownerUserId: Number(process.env.OWNER_USER_ID || 0),
  requiredChannelId: Number(process.env.REQUIRED_CHANNEL_ID || 0),
  requiredChannelLink: process.env.REQUIRED_CHANNEL_LINK || '',
};
