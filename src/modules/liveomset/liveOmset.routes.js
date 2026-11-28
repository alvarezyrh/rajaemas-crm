import { actorOf } from '../../core/http/context.js';
import { openStream } from '../../core/http/sse.js';
import { Permissions as P } from '../../security/rbac.js';

const UPDATE_INTERVAL_MS = 2_000;

export function registerLiveOmsetRoutes(router, { liveOmset, guard }) {
  router.get(
    '/api/v1/live-omset/stream',
    guard.authenticate,
    guard.authorize(P.LIVE_OMSET_READ),
    async (ctx) => {
      const source = await liveOmset.open(actorOf(ctx));
      const stream = openStream(ctx);
      let publishing = false;

      async function publish() {
        if (stream.isClosed() || publishing) return;
        publishing = true;
        try {
          const snapshot = await source.snapshot();
          if (!stream.isClosed()) stream.send('omset', snapshot);
        } catch (err) {
          ctx.log.error('live_omset.snapshot_failed', { err });
          stream.send('stream-error', { message: 'Live omset is temporarily unavailable' });
          stream.close();
        } finally {
          publishing = false;
        }
      }

      const timer = setInterval(publish, UPDATE_INTERVAL_MS);
      timer.unref();
      stream.onClose(() => clearInterval(timer));
      await publish();
    },
  );
}
