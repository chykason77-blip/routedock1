import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const outputDirectory = join(process.env.RUNNER_TEMP, 'e2e-provider-logs');
const normalize = (text) => stripVTControlCharacters(text).replaceAll('\r\n', '\n');
const secrets = new Set();
for (const name of ['AGENT_SECRET', 'COMMITMENT_SECRET', 'E2E_PAYEE_SECRET', 'STELLAR_PAYEE_SECRET']) {
  const value = process.env[name];
  if (!value) continue;
  // Wrangler may quote --var values; multiline values may also be logged a line at a time.
  for (const part of [value, normalize(value), ...value.split(/\r?\n/)]) {
    if (!part) continue;
    for (const rendered of [part, JSON.stringify(part).slice(1, -1), JSON.stringify(part)]) {
      secrets.add(rendered);
      // Wrangler's printBindings truncates visible values at 40 characters, including "...".
      if (rendered.length >= 40) secrets.add(`${rendered.slice(0, 37)}...`);
    }
  }
}

function redact(text) {
  const ranges = [];
  for (const secret of secrets) {
    for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1)) {
      ranges.push([start, start + secret.length]);
    }
  }
  // Merge matches on the original text, so overlapping secrets cannot leave suffixes behind.
  ranges.sort((a, b) => a[0] - b[0]);
  let result = '';
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const [start, firstEnd] = ranges[i];
    let end = firstEnd;
    while (i + 1 < ranges.length && ranges[i + 1][0] <= end) {
      end = Math.max(end, ranges[++i][1]);
    }
    result += text.slice(cursor, start) + '[REDACTED]';
    cursor = end;
  }
  return result + text.slice(cursor);
}

try {
  rmSync(outputDirectory, { recursive: true, force: true });
  const logs = ['provider-a', 'provider-b'].map((provider) => {
    let raw;
    try {
      raw = readFileSync(join(process.env.RUNNER_TEMP, `${provider}.log`), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      raw = 'Provider log was not created.\n';
    }
    return [provider, redact(normalize(raw))];
  });
  mkdirSync(outputDirectory, { mode: 0o700 });
  for (const [provider, log] of logs) {
    writeFileSync(join(outputDirectory, `${provider}.log`), log, { mode: 0o600 });
  }
  for (const [provider, log] of logs) {
    console.log(`::group::${provider} log (last 200 lines, up to 32K characters)`);
    // Redact the full log before truncation, including secrets crossing the tail boundary.
    const tail = log.trimEnd().split('\n').slice(-200).join('\n').slice(-32768);
    for (const line of (tail || '(empty log)').split('\n')) console.log(`| ${line}`);
    console.log('::endgroup::');
  }
} catch {
  // Fail closed: never fall back to printing or uploading raw output, including error objects.
  rmSync(outputDirectory, { recursive: true, force: true });
  console.error('::warning::Unable to prepare sanitized provider logs. Raw logs were not published.');
  process.exitCode = 1;
}
