import type { ParcelWorkerFactory } from '../ui/parcel-run-controller';

export const createParcelWorker: ParcelWorkerFactory = () =>
  new Worker(new URL('./parcel.worker.ts', import.meta.url), {
    type: 'module',
  });
