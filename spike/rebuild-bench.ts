// Rebuild-cost benchmark for the persistence recommendation (not a test; timings depend on load):
//   node --expose-gc --import tsx spike/rebuild-bench.ts
// For KyberSwing (daily request.security) it measures, per warm-up window W (chart bars):
//   - warm start: createStepper({ history: W bars }) = one page over W bars (same path as a full run)
//   - stepping the next 500 bars (HTF rebuilt at UTC day boundaries), us per bar
//   - how many of the full-history run's entries in those 500 bars the windowed instance reproduces
//   - retained heap per warm instance (10 instances kept alive, needs --expose-gc)
import { fixtureCandles, probeSource, createStepper, runScript, type BrokerView, type OrderCall } from './probe.js';

const candles = fixtureCandles();
const FLAT: BrokerView = { position_size: 0, position_avg_price: NaN, equity: 10_000, netprofit: 0, openprofit: 0, opentrades: [] };
const broker = () => FLAT;
const key = (c: OrderCall) => `${c.time}|${c.method}|${JSON.stringify(c.args)}`;
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const kyb = probeSource('08-kyberswing');
const N = candles.length;
const TAIL = 500;

const t0 = performance.now();
const full = await runScript(kyb, candles, { provider: true, broker });
const fullMs = performance.now() - t0;
const fullTail = full.calls.filter((c) => c.bar >= N - TAIL && c.method === 'entry').map(key);
console.log(JSON.stringify({ fullRunBars: N, fullRunMs: Math.round(fullMs), fullHistoryEntriesInTail: fullTail.length }));

for (const W of [1000, 2000, 3000, 4500, N - TAIL]) {
  const hist = candles.slice(N - TAIL - W, N - TAIL);
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const keep = [];
  const w0 = performance.now();
  for (let i = 0; i < 10; i++) keep.push(await createStepper(kyb, { provider: true, broker, history: hist, htfRefresh: 'day-boundary' }));
  const warmMs = (performance.now() - w0) / 10;
  gc();
  const heapPerInstanceMB = (process.memoryUsage().heapUsed - heap0) / 10 / 1e6;
  const st = keep[0]!;
  keep.length = 1;
  const s0 = performance.now();
  for (const c of candles.slice(N - TAIL)) await st.push(c);
  const stepUs = ((performance.now() - s0) * 1000) / TAIL;
  const got = st.calls.filter((c) => c.time >= candles[N - TAIL]!.openTime && c.method === 'entry').map(key);
  console.log(
    JSON.stringify({
      window: W,
      warmMs: Math.round(warmMs),
      stepUsPerBar: Math.round(stepUs),
      heapPerInstanceMB: +heapPerInstanceMB.toFixed(2),
      entriesInTail: got.length,
      matchingFullHistory: got.filter((k) => fullTail.includes(k)).length,
      rebuild2500InstancesMin: +((2500 * warmMs) / 60_000).toFixed(1),
    }),
  );
}
