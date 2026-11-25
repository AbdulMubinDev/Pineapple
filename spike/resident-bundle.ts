// Bundles spike/resident.ts (and ./hook-core) for an isolated-vm isolate with esbuild (installed
// as a dependency of tsx). `pinets` is replaced by the PineTS browser bundle's global, so the code
// in the isolate is the same code the Node tests check.
import { build } from 'esbuild';

export async function residentBundle(): Promise<string> {
  const out = await build({
    stdin: {
      contents: "export { FeedStore, SharedScript, ResidentInstance } from '../src/engine/resident.ts';",
      resolveDir: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'Resident',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    plugins: [
      {
        name: 'pinets-global',
        setup(b) {
          b.onResolve({ filter: /^pinets$/ }, () => ({ path: 'pinets', namespace: 'pinets-global' }));
          b.onLoad({ filter: /.*/, namespace: 'pinets-global' }, () => ({
            contents: 'export const PineTS = globalThis.PineTSLib.PineTS; export const Indicator = globalThis.PineTSLib.Indicator;',
            loader: 'js',
          }));
        },
      },
    ],
  });
  return out.outputFiles[0]!.text;
}
