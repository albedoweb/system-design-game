import type { ImageWorkerFactory } from '../ui/image-run-controller';

export const createImageWorker: ImageWorkerFactory = () =>
  new Worker(new URL('./image.worker.ts', import.meta.url), {
    type: 'module',
  });
