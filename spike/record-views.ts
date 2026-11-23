// Writes the scripted-broker views for KyberSwing (see recordEmulatorViews) as JSON, for the
// layout bench:  node --import tsx spike/record-views.ts <out.json>
import { writeFileSync } from 'node:fs';
import { fixtureCandles, probeSource, recordEmulatorViews } from './probe.js';

const out = process.argv[2];
if (!out) throw new Error('usage: record-views.ts <out.json>');
const views = await recordEmulatorViews(probeSource('08-kyberswing'), fixtureCandles());
// NaN (flat position_avg_price, unknown entry values) is not JSON: written as null, read back as NaN.
writeFileSync(out, JSON.stringify(views));
console.log(JSON.stringify({ views: views.length, barsInPosition: views.filter((v) => v.position_size !== 0).length }));
