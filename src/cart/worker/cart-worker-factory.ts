import type { CartWorkerFactory } from '../ui/cart-run-controller';

export const createCartWorker: CartWorkerFactory = () =>
  new Worker(new URL('./cart.worker.ts', import.meta.url), {
    type: 'module',
  });
