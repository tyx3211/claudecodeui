import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

type CliOptions = {
  readonly databasePath: string;
  readonly username: string | null;
};

type UserCountRow = {
  readonly count: number;
};

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 6;
const BCRYPT_SALT_ROUNDS = 12;

function resolveDefaultDatabasePath(): string {
  return process.env.DATABASE_PATH ?? path.join(os.homedir(), '.cloudcli', 'auth.db');
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let databasePath = resolveDefaultDatabasePath();
  let username: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--database') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--database requires a path value.');
      }

      databasePath = value;
      index += 1;
      continue;
    }

    if (arg === '--username') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--username requires a value.');
      }

      username = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { databasePath, username };
}

async function promptVisible(question: string): Promise<string> {
  const readline = createInterface({ input, output });

  try {
    return await readline.question(question);
  }
  finally {
    readline.close();
  }
}

async function promptHidden(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    const chunks: Buffer[] = [];

    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }

    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  }

  return await new Promise<string>((resolve, reject) => {
    let password = '';
    const previousRawMode = input.isRaw;

    const cleanup = (): void => {
      input.off('data', onData);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write('\n');
    };

    const finish = (): void => {
      cleanup();
      resolve(password);
    };

    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');

      for (const char of text) {
        if (char === '\u0003') {
          fail(new Error('Interrupted.'));
          return;
        }

        if (char === '\r' || char === '\n') {
          finish();
          return;
        }

        if (char === '\u007f' || char === '\b') {
          password = password.slice(0, -1);
          continue;
        }

        if (char >= ' ') {
          password += char;
        }
      }
    };

    output.write(question);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function ensureUserTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
`);
}

function assertValidCredentials(username: string, password: string): void {
  if (username.length < MIN_USERNAME_LENGTH) {
    throw new Error(`Username must be at least ${MIN_USERNAME_LENGTH} characters.`);
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const username = options.username ?? (await promptVisible('Username: ')).trim();
  const password = await promptHidden('Password: ');

  assertValidCredentials(username, password);

  const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  const db = new Database(options.databasePath);

  try {
    ensureUserTable(db);

    db.transaction(() => {
      const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as UserCountRow;

      if (row.count > 0) {
        throw new Error('A CloudCLI user already exists. This deployment is configured as single-user.');
      }

      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    })();
  }
  finally {
    db.close();
  }

  output.write(`Created local CloudCLI user "${username}" in ${options.databasePath}.\n`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create local CloudCLI user: ${message}`);
  process.exitCode = 1;
});
