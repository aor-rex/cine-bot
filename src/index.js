import 'dotenv/config';
import { getDb } from './db/index.js';

const command = process.argv[2];

async function main() {
  getDb(); // ensure DB initialized

  switch (command) {
    case 'bot':
      const { startBot } = await import('./bot/index.js');
      await startBot();
      break;

    case 'init-scan':
      const { initScan } = await import('./init-scan.js');
      await initScan();
      break;

    default:
      console.log(`
Usage: node src/index.js <command>

Commands:
  bot        - Start the Telegram bot
  init-scan  - One-time scan of source group history (uses gramJS)
      `);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
