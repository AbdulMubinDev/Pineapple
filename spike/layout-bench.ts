// Task 2b fix round: the recommended layout, measured. One isolate per run, N KyberSwing
// instances per isolate, each instance on its own FeedStore (one store per pair, as in
// production), stepped with a scripted broker (real positions, see recordEmulatorViews).
//   node --expose-gc --import tsx spike/layout-bench.ts <views.json> [isolates=5] [perIsolate=100]
//        [steps=1000] [warm=500] [keep=60] [htfKeep=10] [slack=20] [limitMB=256]
// Prints JSON lines: absolute process RSS and cgroup memory (when in a container) at each stage,
// per-isolate heap, and pass times (mean, median, p95, max) over all passes.
import { readFileSync } from 'node:fs';
import ivm from 'isolated-vm';
import { pinetsBrowserBundle } from './isolate.js';
import { BTCUSDT_PERP_SYMINFO, fixtureCandles, probeSource } from './probe.js';
import { residentBundle } from './resident-bundle.js';

const [viewsPath, ...rest] = process.argv.slice(2);
if (!viewsPath) throw new Error('usage: layout-bench.ts <views.json> [...]');
const [isolates = 5, perIso = 100, steps = 1000, warm = 500, keep = 60, htfKeep = 10, slack = 20, limitMb = 256] = rest.map(Number);
const MB = (b: number) => +(b / 1e6).toFixed(1);
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const cg = (f: string) => {
  try {
    return Number(readFileSync(`/sys/fs/cgroup/${f}`, 'utf8').trim());
  } catch {
    return NaN;
  }
};
const mem = () => {
  gc();
  return { rssMB: MB(process.memoryUsage().rss), hostHeapMB: MB(process.memoryUsage().heapUsed), cgroupCurrentMB: MB(cg('memory.current')), cgroupPeakMB: MB(cg('memory.peak')) };
};
const log = (o: object) => console.log(JSON.stringify(o));

const DRIVER = `
globalThis.__setup = async function (candles, views, info, src, n, keep, htfKeep, slack, warm) {
  const R = globalThis.Resident;
  for (const v of views) {
    if (v.position_avg_price === null) v.position_avg_price = NaN;
    for (const t of v.opentrades) for (const k of Object.keys(t)) if (t[k] === null) t[k] = NaN;
  }
  globalThis.__candles = candles;
  globalThis.__next = warm;
  globalThis.__keep = keep;
  globalThis.__htfKeep = htfKeep;
  const script = new R.SharedScript(src);
  const broker = (bar) => views[bar];
  globalThis.__pairs = [];
  for (let i = 0; i < n; i++) {
    const store = new R.FeedStore('240', 14400000, info, candles.slice(0, warm));
    const inst = await R.ResidentInstance.create(script, store, { broker, keep, htfKeep, slack });
    inst.drain();
    store.trim(keep, htfKeep);
    globalThis.__pairs.push({ store, inst });
  }
  return n;
};
globalThis.__pass = async function () {
  const c = globalThis.__candles[globalThis.__next++];
  let calls = 0;
  for (const p of globalThis.__pairs) {
    p.store.append(c);
    await p.inst.step();
    calls += p.inst.drain().length;
    p.store.trim(globalThis.__keep, globalThis.__htfKeep);
  }
  return calls;
};
`;

const candles = fixtureCandles().slice(0, warm + steps + 1);
const views = (JSON.parse(readFileSync(viewsPath, 'utf8')) as unknown[]).slice(0, warm + steps + 1);
const info = JSON.parse(JSON.stringify(BTCUSDT_PERP_SYMINFO)) as object;
const src = probeSource('08-kyberswing');
log({ stage: 'host loaded (node + tsx + fixture + views)', node: process.version, platform: `${process.platform}-${process.arch}`, isolates, perIso, steps, warm, keep, htfKeep, slack, limitMb, ...mem() });
const bundle = pinetsBrowserBundle();
const resident = await residentBundle();
log({ stage: 'bundles built', ...mem() });

type Iso = { isolate: ivm.Isolate; context: ivm.Context; pass: ivm.Reference<() => Promise<number>> };
const isos: Iso[] = [];
const heapOf = async (i: Iso) => {
  await i.context.eval('typeof gc === "function" && (gc(), gc())');
  const h = await i.isolate.getHeapStatistics();
  // externally_allocated_size: ArrayBuffer backing stores (the ta History Float64Arrays live there).
  return { usedMB: MB(h.used_heap_size), totalMB: MB(h.total_heap_size), externalMB: MB(h.externally_allocated_size), mallocedMB: MB(h.malloced_memory) };
};
try {
  for (let k = 0; k < isolates; k++) {
    const isolate = new ivm.Isolate({ memoryLimit: limitMb });
    const context = await isolate.createContext();
    await context.global.set('globalThis', context.global.derefInto());
    await context.eval('globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };');
    await (await isolate.compileScript(bundle)).run(context);
    await (await isolate.compileScript(resident)).run(context);
    await context.eval(DRIVER);
    const empty = await heapOf({ isolate, context } as Iso);
    const memEmpty = mem();
    const setup = (await context.global.get('__setup', { reference: true })) as ivm.Reference<(...a: unknown[]) => Promise<number>>;
    const t0 = performance.now();
    await setup.apply(
      undefined,
      [new ivm.ExternalCopy(candles).copyInto(), new ivm.ExternalCopy(views).copyInto(), new ivm.ExternalCopy(info).copyInto(), src, perIso, keep, htfKeep, slack, warm],
      { result: { promise: true } },
    );
    const warmMs = (performance.now() - t0) / perIso;
    const pass = (await context.global.get('__pass', { reference: true })) as Iso['pass'];
    const iso = { isolate, context, pass };
    isos.push(iso);
    log({ stage: `isolate ${k + 1} ready`, emptyIsolateHeap: empty, emptyIsolateMem: memEmpty, heap: await heapOf(iso), warmStartMsPerInstance: Math.round(warmMs), ...mem() });
  }
  const passMs: number[] = [];
  let calls = 0;
  for (let s = 1; s <= steps; s++) {
    const t = performance.now();
    for (const i of isos) calls += (await i.pass.apply(undefined, [], { result: { promise: true } })) as number;
    passMs.push(performance.now() - t);
    if (s % 100 === 0) {
      const w = passMs.slice(-100).sort((a, b) => a - b);
      log({ stepped: s, passMsMean: +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1), passMsMax: +w[99]!.toFixed(1), heaps: await Promise.all(isos.map(heapOf)), ...mem() });
    }
  }
  const all = passMs.slice().sort((a, b) => a - b);
  const q = (p: number) => +all[Math.min(all.length - 1, Math.floor(p * all.length))]!.toFixed(1);
  const total = isolates * perIso;
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  log({
    stage: 'done',
    instances: total,
    passes: all.length,
    passMsMean: +mean.toFixed(1),
    passMsMedian: q(0.5),
    passMsP95: q(0.95),
    passMsP99: q(0.99),
    passMsMax: +all[all.length - 1]!.toFixed(1),
    msPerInstancePerBarMean: +(mean / total).toFixed(3),
    extrapolated2500PassSMean: +((mean / total) * 2500 / 1000).toFixed(2),
    extrapolated2500PassSMax: +((all[all.length - 1]! / total) * 2500 / 1000).toFixed(2),
    callsDrained: calls,
    ...mem(),
  });
} catch (e) {
  log({ stage: 'FAILED', isolatesReady: isos.length, error: String((e as Error)?.message ?? e), ...mem() });
  process.exitCode = 1;
}
