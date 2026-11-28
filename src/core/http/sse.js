/** Opens a Server-Sent Events response with heartbeat and disconnect cleanup. */
export function openStream(ctx) {
  const { req, res } = ctx;
  const closeListeners = new Set();
  let closed = false;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, 25_000);
  heartbeat.unref();

  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    req.off('aborted', finish);
    res.off('close', finish);
    res.off('error', finish);
    for (const listener of closeListeners) listener();
    closeListeners.clear();
  }

  req.on('aborted', finish);
  res.on('close', finish);
  res.on('error', finish);

  return Object.freeze({
    send(event, data) {
      if (closed || res.destroyed || res.writableEnded) return false;
      return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      finish();
      res.end();
    },
    isClosed: () => closed,
    onClose(listener) {
      if (closed) listener();
      else closeListeners.add(listener);
    },
  });
}
