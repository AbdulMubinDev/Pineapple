// Headless scanner CLI (before the web UI). Uses data/pineapple.db.
//   npx tsx src/cli/scan.ts start --name <n> --script <file.pine> --tf 4h --balance 10000 [--fixed-usd 100]
//   npx tsx src/cli/scan.ts list
//   npx tsx src/cli/scan.ts status <id>
//   npx tsx src/cli/scan.ts pause <id> | resume <id> | stop <id>
// `start` runs in the foreground: it prints warm-up progress, then one PassReport line per close. pause / resume / stop
// from another shell write the run's status to the database; the running `start` applies it within a few seconds
// and exits once its run is stopped. Ctrl+C stops the process but leaves the run's status as it is.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_FEES } from '../broker/costs.js';
import { isTimeframe } from '../core/timeframe.js';
import type { SizingRule } from '../core/types.js';
import { BinanceClient } from '../exchange/binance.js';
import { RunManager } from '../scanner/manager.js';
import type { PassReport } from '../scanner/run.js';
import { openDb } from '../store/db.js';
import { RunRepo, type RunStatus } from '../store/runs.js';

const DB_PATH = 'data/pineapple.db';
const SYNC_MS = 3_000;

const iso = (t: number) => (t > 0 ? new Date(t).toISOString().replace('.000Z', 'Z') : '-');
const stamp = () => new Date().toISOString().slice(11, 19);

function open() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  return openDb(DB_PATH);
}

export function formatReport(runId: number, r: PassReport): string {
  const skipped = Object.entries(r.skipped)
    .map(([k, v]) => `${k}=${v.length}`)
    .join(' ');
  const errors = r.errors.length > 0 ? ` errors=${r.errors.map((e) => `${e.symbol}: ${e.message}`).join('; ')}` : '';
  const late = r.latencyMs > PASS_DEADLINE_MS ? ' DEADLINE MISSED' : '';
  return `[${stamp()}] run ${runId} close ${iso(r.closeTime)} scanned=${r.scanned} ${skipped ? `skipped: ${skipped} ` : ''}durationMs=${r.durationMs} latencyMs=${r.latencyMs}${late}${r.rejected ? ' COMMIT REJECTED (state reloaded)' : ''}${errors}`;
}

async function start(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      script: { type: 'string' },
      tf: { type: 'string', default: '4h' },
      balance: { type: 'string', default: '10000' },
      'fixed-usd': { type: 'string' },
    },
  });
  if (!values.name || !values.script) throw new Error('start needs --name and --script');
  if (!isTimeframe(values.tf)) throw new Error(`--tf ${values.tf} is not supported`);
  const balance = Number(values.balance);
  if (!(balance > 0)) throw new Error('--balance must be a positive number');
  let sizing: SizingRule = { kind: 'script' };
  if (values['fixed-usd'] !== undefined) {
    const usd = Number(values['fixed-usd']);
    if (!(usd > 0)) throw new Error('--fixed-usd must be a positive number');
    sizing = { kind: 'fixed', notionalUsd: usd };
  }
  const source = readFileSync(values.script, 'utf8');

  const db = open();
  const client = new BinanceClient();
  const t0 = Date.now();
  const manager = new RunManager({
    db,
    client,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    onReport: (id, r) => {
      const s = manager.status(id);
      console.log(`${formatReport(id, r)} peakWeight=${client.budget.peakUsedWeight}${s.warnings.length ? ` warnings=${s.warnings.join(',')}` : ''}`);
    },
    onEvent: (id, m) => console.log(`[${stamp()}] ${id === null ? 'scanner' : `run ${id}`}: ${m}`),
  });
  const id = await manager.start({ name: values.name, setup: { script: source, exchange: 'binance', tf: values.tf, startingBalance: balance, sizing, fees: DEFAULT_FEES } }, (runId) =>
    console.log(`[${stamp()}] run ${runId} created (${values.name}, ${values.tf}); warming up`),
  );
  const s = manager.status(id);
  console.log(
    `[${stamp()}] run ${id} live: universe=${s.universe} skipped=${JSON.stringify(s.skipped)} warm-up ${((Date.now() - t0) / 1000).toFixed(0)} s, peak used weight ${client.budget.peakUsedWeight}`,
  );

  // The manager's heartbeat applies pause / resume / stop written by other shells; exit once no run is left.
  manager.onHeartbeat = () => {
    if (manager.liveRuns().length > 0) return;
    manager.shutdown();
    console.log(`[${stamp()}] run ${id} stopped; exiting`);
    db.close();
  };
  process.once('SIGINT', () => {
    // Releases the lease; the run keeps its status (Task 8 resumes it on the next start).
    manager.shutdown();
    console.log(`[${stamp()}] interrupted; run ${id} keeps status ${manager.repo.getRun(id)?.status}`);
    process.exit(130);
  });
}

function list(): void {
  const repo = new RunRepo(open());
  const runs = repo.listRuns();
  if (runs.length === 0) console.log('no runs');
  for (const r of runs) {
    const st = repo.loadState(r.id);
    console.log(`${r.id}\t${r.status}\t${r.name}\t${r.setup.tf}\tcreated ${iso(r.createdAt)}\tlast close ${iso(st?.lastClose ?? 0)}`);
  }
}

function status(id: number): void {
  const repo = new RunRepo(open());
  const r = repo.getRun(id);
  if (!r) throw new Error(`no run ${id}`);
  const st = repo.loadState(id);
  const trades = repo.trades(id);
  const eq = repo.equityCurve(id).at(-1);
  console.log(`run ${r.id} "${r.name}" ${r.status} tf=${r.setup.tf} balance=${r.setup.startingBalance} sizing=${JSON.stringify(r.setup.sizing)}`);
  console.log(`last close ${iso(st?.lastClose ?? 0)}; equity ${eq ? eq.equity.toFixed(2) : '-'}; open positions ${Object.keys(st?.broker.positions ?? {}).length}; trades ${trades.length}`);
  const counts = new Map<string, number>();
  for (const l of repo.logs(id)) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
  console.log(`log: ${[...counts].map(([k, n]) => `${k}=${n}`).join(' ') || 'empty'}`);
  for (const l of repo.logs(id).slice(-10)) console.log(`  ${iso(l.time)} ${l.kind} ${l.symbol ?? ''} ${l.detail === undefined ? '' : JSON.stringify(l.detail)}`);
}

function setStatus(id: number, s: RunStatus): void {
  const repo = new RunRepo(open());
  const r = repo.getRun(id);
  if (!r) throw new Error(`no run ${id}`);
  if (r.status === 'stopped') throw new Error(`run ${id} is stopped`);
  repo.setStatus(id, s);
  console.log(`run ${id}: ${s} (the scanner process applies it within ${SYNC_MS / 1000} s)`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const id = () => {
    const n = Number(rest[0]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${cmd} needs a run id`);
    return n;
  };
  switch (cmd) {
    case 'start':
      return start(rest);
    case 'list':
      return list();
    case 'status':
      return status(id());
    case 'pause':
      return setStatus(id(), 'paused');
    case 'resume':
      return setStatus(id(), 'running');
    case 'stop':
      return setStatus(id(), 'stopped');
    default:
      throw new Error('usage: scan.ts start --name <n> --script <file> --tf 4h --balance 10000 [--fixed-usd 100] | list | status <id> | pause <id> | resume <id> | stop <id>');
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
