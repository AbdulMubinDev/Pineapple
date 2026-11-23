// Task 2b bench (not a test): resident KyberSwing instances, memory and pass time.
//   node --expose-gc --import tsx spike/resident-bench.ts [instances=50] [keep=100|0] [htfKeep=50] [warm=3000] [steps=1500] [slack=keep] [--breakdown]
// Heap is sampled (after full GC) every 100 passes; each 500-pass line reports the min and max.
// All instances share one FeedStore (one symbol) and one SharedScript (one transpile). Each pass
// appends one 4h bar to the store and steps every instance once. Prints JSON lines.
import { fixtureCandles, probeSource, BTCUSDT_PERP_SYMINFO, type BrokerView } from './probe.js';
import { FeedStore, SharedScript, ResidentInstance } from './resident.js';

const [n = 50, keepArg = 100, htfKeep = 50, warm = 3000, steps = 1500, slackArg = 0] = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(Number);
const keep = keepArg > 0 ? keepArg : undefined;
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};
const MB = (b: number) => +(b / 1e6).toFixed(3);

const candles = fixtureCandles();
const FLAT: BrokerView = { position_size: 0, position_avg_price: NaN, equity: 10_000, netprofit: 0, openprofit: 0, opentrades: [] };
const store = new FeedStore('240', 14_400_000, BTCUSDT_PERP_SYMINFO, candles.slice(0, warm));
const h0 = heap();
const script = new SharedScript(probeSource('08-kyberswing'));
const h1 = heap();
const insts: ResidentInstance[] = [];
const c0 = performance.now();
let calls = 0;
for (let i = 0; i < n; i++) {
  const inst = await ResidentInstance.create(script, store, { broker: () => FLAT, keep, htfKeep: keep ? htfKeep : undefined, slack: slackArg > 0 ? slackArg : undefined });
  calls += inst.drain().length; // production hands calls to the broker every bar
  insts.push(inst);
}
const createMs = (performance.now() - c0) / n;
const h2 = heap();
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, instances: n, keep: keep ?? 'none', htfKeep: keep ? htfKeep : 'none', slack: slackArg > 0 ? slackArg : keep ?? 'none', warm, scriptMB: MB(h1 - h0), warmStartMsPerInstance: Math.round(createMs), heapPerInstanceAfterWarmMB: MB((h2 - h1) / n) }));
const passMs: number[] = [];
let samples: number[] = [];
for (let s = 1; s <= steps; s++) {
  store.append(candles[warm + s - 1]!);
  const t = performance.now();
  for (const inst of insts) {
    await inst.step();
    calls += inst.drain().length;
  }
  if (keep) store.trim(keep, htfKeep);
  passMs.push(performance.now() - t);
  if (s % 100 === 0) samples.push((heap() - h1) / n);
  if (s % 500 === 0) {
    const recent = passMs.slice(-500).sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        stepped: s,
        heapPerInstanceMBMin: MB(Math.min(...samples)),
        heapPerInstanceMBMax: MB(Math.max(...samples)),
        passMsMedian: +recent[250]!.toFixed(2),
        passMsP95: +recent[475]!.toFixed(2),
        passMsMax: +recent[499]!.toFixed(2),
        msPerInstancePerBar: +(recent[250]! / n).toFixed(3),
        extrapolated2500InstancesPassS: +((recent[250]! / n) * 2500 / 1000).toFixed(2),
      }),
    );
    samples = [];
  }
}
console.log(JSON.stringify({ rssMB: MB(process.memoryUsage().rss), callsDrained: calls }));

// --breakdown: free one component at a time from every instance and report what it held.
if (process.argv.includes('--breakdown')) {
  type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const xs = insts as unknown as { ctx: R; pine: R; gen: unknown }[];
  let prev = heap();
  const freed = (label: string, f: (x: { ctx: R; pine: R; gen: unknown }) => void) => {
    for (const x of xs) f(x);
    const h = heap();
    console.log(JSON.stringify({ component: label, KBPerInstance: +((prev - h) / n / 1e3).toFixed(1) }));
    prev = h;
  };
  const secOf = (x: { ctx: R }) => Object.values(x.ctx.cache).find((v) => (v as R)?.context) as R | undefined;
  const s0 = secOf(xs[0]!);
  console.log(JSON.stringify({ secondaryBars: s0?.context.data.openTime.data.length, mainScopeSizes: ['const', 'var', 'let', 'params'].map((k) => Object.keys(xs[0]!.ctx[k] ?? {}).length), mainTaState: Object.keys(xs[0]!.ctx.taState ?? {}).length, secTaState: Object.keys(s0?.context.taState ?? {}).length }));
  freed('secondary taState', (x) => { const s = secOf(x); if (s) s.context.taState = {}; });
  freed('secondary scopes+data', (x) => { const s = secOf(x); if (s) { for (const k of ['const', 'var', 'let', 'params']) s.context[k] = {}; s.context.data = {}; s.context.plots = {}; } });
  freed('secondary rest (Context, PineTS, candles)', (x) => { for (const k of Object.keys(x.ctx.cache)) delete x.ctx.cache[k]; });
  freed('main taState', (x) => { x.ctx.taState = {}; });
  freed('main scopes (var/let/const/params)', (x) => { for (const k of ['const', 'var', 'let', 'params']) x.ctx[k] = {}; });
  freed('main plots', (x) => { x.ctx.plots = {}; });
  freed('main data series', (x) => { x.ctx.data = {}; });
  freed('main chart arrays', (x) => { for (const k of ['data', 'open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'openTime', 'closeTime']) x.pine[k] = []; });
  freed('rest (Context + namespaces, PineTS, generator)', (x) => { x.ctx = {}; x.pine = {}; x.gen = null; });
}
