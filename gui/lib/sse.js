// Minimal Server-Sent Events helper over plain http.ServerResponse - no
// dependency needed, text/event-stream is directly writable and the browser's
// native EventSource handles parsing/reconnect on its own.

export function writeSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Comment ping so proxies/browsers flush the connection open immediately.
  res.write(":ok\n\n");
}

export function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
