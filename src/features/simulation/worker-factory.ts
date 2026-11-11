import type { WorkerFactory } from './worker-client';

export const createSimulationWorker: WorkerFactory = () =>
  new Worker(
    new URL('../../workers/simulation.worker.ts', import.meta.url),
    { type: 'module' },
  );
