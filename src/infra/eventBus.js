import { EventEmitter } from 'node:events';

/**
 * In-process event bus for asynchronous work off the HTTP response path.
 * Failing handlers are logged without crashing the process.
 * For multiple instances the adapter can move to Redis Streams without changing callers.
 */
export function createEventBus(logger) {
  const emitter = new EventEmitter();
  const pending = new Set();

  return Object.freeze({
    publish(event, payload) {
      setImmediate(() => emitter.emit(event, payload));
    },

    subscribe(event, handler) {
      emitter.on(event, (payload) => {
        const task = Promise.resolve()
          .then(() => handler(payload))
          .catch((err) => logger.error('event.handler_failed', { event, err }))
          .finally(() => pending.delete(task));
        pending.add(task);
      });
    },

    /** Waits for running handlers (graceful shutdown). */
    drain: () => Promise.allSettled([...pending]),
  });
}
