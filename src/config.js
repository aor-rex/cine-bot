import 'dotenv/config';

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  ownerUserId: Number(process.env.OWNER_USER_ID || 0),
};
