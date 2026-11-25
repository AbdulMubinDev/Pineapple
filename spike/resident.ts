// Task 2b: resident script instances with bounded history. The code moved to src/engine/resident.ts
// (one source); this module keeps the spike's names for its tests and benches.
export {
  FeedStore,
  ResidentInstance,
  SharedScript,
  SlidingArray,
  StoreProvider,
  installUpdateTailFix,
  trimContext,
  trimTaState,
  type Bar,
  type InstanceOptions,
} from '../src/engine/resident.js';

export const H4_MS = 14_400_000;
export const DAY_MS = 86_400_000;
