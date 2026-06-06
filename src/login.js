import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

async function main() {
  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;

  if (!apiId || !apiHash) {
    console.error('Set API_ID and API_HASH in .env before running login.');
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(process.env.SESSION_STRING || ''),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );
  const rl = createInterface({ input, output });

  try {
    await client.start({
      phoneNumber: async () => rl.question('Phone number (include country code): '),
      password: async () => rl.question('2FA password (leave blank if none): '),
      phoneCode: async () => rl.question('Telegram login code: '),
      onError: (err) => console.error('Login error:', err?.message || err),
    });

    const session = client.session.save();

    console.log('\n✅ Login successful.');
    console.log('\nSESSION_STRING=');
    console.log(session);
    console.log('\nAdd that value to your .env file, then run:');
    console.log('node src/index.js init-scan');

    await client.disconnect();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
