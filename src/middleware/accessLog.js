import diagnosticsChannel from 'node:diagnostics_channel';

/** Diagnostics channel: APM/metrics subscribers can observe requests without code changes. */
export const httpRequestChannel = diagnosticsChannel.channel('rajaemas:http.request');

export function accessLog() {
  return async (ctx, next) => {
    const startedAt = process.hrtime.bigint();
    try {
      await next();
    } finally {
      const entry = {
        method: ctx.method,
        path: ctx.path,
        status: ctx.res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100,
        userId: ctx.state.user?.id,
        ip: ctx.ip,
      };
      ctx.log.info('http.request', entry);
      if (httpRequestChannel.hasSubscribers) {
        httpRequestChannel.publish({ ...entry, requestId: ctx.requestId });
      }
    }
  };
}
