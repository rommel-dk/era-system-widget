import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', '..', 'data');
const outPath = path.join(dataDir, 'system.json');

fs.mkdirSync(dataDir, { recursive: true });

const payload = {
  overall: 'warn',
  updatedAt: new Date().toISOString(),
  messages: [
    {
      name: 'AWS mail delivery degraded',
      status: 'warning',
      solved: 'yes',
      message: 'Emails may be delayed due to upstream issues.'
    },
    {
      name: 'Client portal outage',
      status: 'error',
      solved: 'no',
      message: 'The client portal is currently unavailable.'
    }
  ]
};

fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
console.log('✅ Dummy system.json written');