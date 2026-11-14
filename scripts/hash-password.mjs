// Produce the scrypt hash for MANAGE_ADMIN_PASSWORD_HASH.
//
//   node scripts/hash-password.mjs              # prompts twice, input hidden
//   printf '%s' "$PW" | node scripts/hash-password.mjs   # non-interactive
//
// Prints ONLY the hash. The password is never echoed, logged, or written.

import { hashPassword } from '../services/manage-api/auth.js';

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\u0003') { stdin.setRawMode(false); reject(new Error('cancelled')); return; }
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stderr.write('\n');
        resolve(value);
        return;
      }
      if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); return; }
      value += ch;
    };
    stdin.on('data', onData);
  });
}

async function readPiped() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

const password = process.stdin.isTTY
  ? await (async () => {
      const a = await readHidden('New admin password: ');
      const b = await readHidden('Repeat password: ');
      if (a !== b) throw new Error('Passwords do not match');
      return a;
    })()
  : await readPiped();

if (password.length < 12) {
  console.error('Refusing: use at least 12 characters.');
  process.exit(1);
}
process.stdout.write(hashPassword(password) + '\n');
