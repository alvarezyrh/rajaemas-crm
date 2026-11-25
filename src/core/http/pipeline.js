/**
 * Composes `(ctx, next) => Promise` middleware into one chained function (onion model).
 * Middleware can run logic before and after `await next()`.
 */
export function compose(middlewares) {
  for (const fn of middlewares) {
    if (typeof fn !== 'function') throw new TypeError('Middleware must be a function');
  }

  return function run(ctx, final) {
    let lastIndex = -1;

    const dispatch = (i) => {
      if (i <= lastIndex) return Promise.reject(new Error('next() called more than once'));
      lastIndex = i;
      const fn = i === middlewares.length ? final : middlewares[i];
      if (!fn) return Promise.resolve();
      try {
        return Promise.resolve(fn(ctx, () => dispatch(i + 1)));
      } catch (err) {
        return Promise.reject(err);
      }
    };

    return dispatch(0);
  };
}
