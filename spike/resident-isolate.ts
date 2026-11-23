// Task 2b, Q4: resident instances inside isolated-vm isolates (bench, not a test).
//   node --expose-gc --import tsx spike/resident-isolate.ts [instances=50] [steps=1000] [isolates=10] [keep=100] [htfKeep=50] [slack=keep] [warm=3000] [limitMB=256]
// spike/resident.ts is bundled with esbuild (already installed as a dependency of tsx; `pinets`
// is replaced by the PineTS browser bundle's global), so the code running in the isolate is the
// same code the Node tests check. Prints JSON lines:
//  - one isolate holding N trimmed KyberSwing instances: isolate heap and process RSS,
//  - K isolates holding 1 instance each: the fixed cost of an isolate.
import ivm from 'isolated-vm';
import { pinetsBrowserBundle } from './isolate.js';
import { BTCUSDT_PERP_SYMINFO, fixtureCandles, probeSource } from './probe.js';
import { residentBundle } from './resident-bundle.js';

const [n = 50, steps = 1000, isolates = 10, keep = 100, htfKeep = 50, slackArg = 0, WARM = 3000, limitMb = 256] = process.argv.slice(2).map(Number);
const slack = slackArg > 0 ? slackArg : keep;
const MB = (b: number) => +(b / 1e6).toFixed(2);
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const rss = () => {
  gc();
  return process.memoryUsage().rss;
};

// Runs inside the isolate. Candles arrive as a copied array; nothing from Node is reachable.
const DRIVER = `
globalThis.__setup = async function (candles, info, src, n, keep, htfKeep, slack, warm) {
  const R = globalThis.Resident;
  const FLAT = { position_size: 0, position_avg_price: NaN, equity: 10000, netprofit: 0, openprofit: 0, opentrades: [] };
  globalThis.__keep = keep;
  globalThis.__htfKeep = htfKeep;
  globalThis.__store = new R.FeedStore('240', 14400000, info, candles.slice(0, warm));
  globalThis.__candles = candles;
  globalThis.__next = warm;
  globalThis.__script = new R.SharedScript(src);
  globalThis.__insts = [];
  globalThis.__calls = 0;
  for (let i = 0; i < n; i++) {
    const inst = await R.ResidentInstance.create(globalThis.__script, globalThis.__store, { broker: () => FLAT, keep, htfKeep, slack });
    globalThis.__calls += inst.drain().length;
    globalThis.__insts.push(inst);
  }
  return n;
};
globalThis.__pass = async function (count) {
  const t0 = Date.now();
  for (let s = 0; s < count; s++) {
    globalThis.__store.append(globalThis.__candles[globalThis.__next++]);
    for (const inst of globalThis.__insts) { await inst.step(); globalThis.__calls += inst.drain().length; }
    globalThis.__store.trim(globalThis.__keep, globalThis.__htfKeep);
  }
  return Date.now() - t0;
};
`;

async function makeIsolate(limitMb: number, bundle: string, resident: string) {
  const isolate = new ivm.Isolate({ memoryLimit: limitMb });
  const context = await isolate.createContext();
  await context.global.set('globalThis', context.global.derefInto());
  await context.eval('globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };');
  await (await isolate.compileScript(bundle)).run(context);
  await (await isolate.compileScript(resident)).run(context);
  await context.eval(DRIVER);
  const heap = async () => {
    await context.eval('typeof gc === "function" && (gc(), gc())');
    const h = await isolate.getHeapStatistics();
    return { used: h.used_heap_size, total: h.total_heap_size };
  };
  return { isolate, context, heap };
}

const candles = fixtureCandles();
const bundle = pinetsBrowserBundle();
const resident = await residentBundle();
const src = probeSource('08-kyberswing');
const info = JSON.parse(JSON.stringify(BTCUSDT_PERP_SYMINFO)) as object;

// (a) one isolate, n instances
{
  const r0 = rss();
  const iso = await makeIsolate(limitMb, bundle, resident);
  const gcInside = await iso.context.eval('typeof gc');
  const base = await iso.heap();
  const setup = (await iso.context.global.get('__setup', { reference: true })) as ivm.Reference<(...a: unknown[]) => Promise<number>>;
  await setup.apply(undefined, [new ivm.ExternalCopy(candles).copyInto(), new ivm.ExternalCopy(info).copyInto(), src, 0, keep, htfKeep, slack, WARM], { result: { promise: true } });
  const withScript = await iso.heap();
  const t0 = performance.now();
  await setup.apply(undefined, [new ivm.ExternalCopy(candles).copyInto(), new ivm.ExternalCopy(info).copyInto(), src, n, keep, htfKeep, slack, WARM], { result: { promise: true } });
  const warmMs = (performance.now() - t0) / n;
  const pass = (await iso.context.global.get('__pass', { reference: true })) as ivm.Reference<(c: number) => Promise<number>>;
  const samples: number[] = [];
  let ms = 0;
  for (let done = 0; done < steps; done += 100) {
    ms += (await pass.apply(undefined, [100], { result: { promise: true } })) as number;
    samples.push((await iso.heap()).used);
  }
  const last = await iso.heap();
  console.log(
    JSON.stringify({
      layout: 'one isolate, many instances',
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      gcInsideIsolate: gcInside,
      instances: n,
      steps,
      warm: WARM,
      memoryLimitMB: limitMb,
      keep,
      htfKeep,
      slack,
      isolateHeapBaseMB: MB(base.used),
      isolateHeapWithStoreAndScriptMB: MB(withScript.used),
      isolateHeapUsedMB: MB(last.used),
      isolateHeapTotalMB: MB(last.total),
      heapPerInstanceMB: MB((Math.max(...samples.slice(-5)) - withScript.used) / n),
      heapPerInstanceMBMin: MB((Math.min(...samples.slice(-5)) - withScript.used) / n),
      warmStartMsPerInstance: Math.round(warmMs),
      msPerInstancePerBar: +(ms / steps / n).toFixed(3),
      processRssDeltaMB: MB(rss() - r0),
    }),
  );
  iso.isolate.dispose();
}

// (b) K isolates, 1 instance each: fixed cost per isolate
if (isolates > 0) {
  const r0 = rss();
  const isos = [];
  let heapSum = 0;
  for (let k = 0; k < isolates; k++) {
    const iso = await makeIsolate(64, bundle, resident);
    const setup = (await iso.context.global.get('__setup', { reference: true })) as ivm.Reference<(...a: unknown[]) => Promise<number>>;
    await setup.apply(undefined, [new ivm.ExternalCopy(candles.slice(0, WARM + 10)).copyInto(), new ivm.ExternalCopy(info).copyInto(), src, 1, keep, htfKeep, slack, WARM], { result: { promise: true } });
    heapSum += (await iso.heap()).used;
    isos.push(iso);
  }
  console.log(JSON.stringify({ layout: 'one isolate per instance', isolates, heapUsedPerIsolateMB: MB(heapSum / isolates), processRssPerIsolateMB: MB((rss() - r0) / isolates) }));
  for (const i of isos) i.isolate.dispose();
}
