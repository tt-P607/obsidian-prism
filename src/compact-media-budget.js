// Obsidian Prism — Opt-in budget for media kept by native context checkpoints.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__agPrismCompactMediaBudget = factory();
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const SEND = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const START_METHOD = `"procedure":"${SEND}"`;
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  function withMediaBudget(request) {
    if (!isRecord(request?.cascadeConfig) || !Array.isArray(request.items) || !request.items.length) return request;
    // Keep the host's inputs to the summarizer, including when compacting a second time.
    if (request.items.some((item) => item?.item?.slashCommand?.info?.name === 'compact')) return request;
    const checkpoint = request.cascadeConfig.checkpointConfig;
    if (checkpoint !== undefined && !isRecord(checkpoint)) return request;
    if (checkpoint?.maxUserRequestMediaTokens === 1) return request;
    return {
      ...request,
      cascadeConfig: {
        ...request.cascadeConfig,
        // In the desktop serializer zero uses the host's default media budget.
        checkpointConfig: { ...checkpoint, maxUserRequestMediaTokens: 1 },
      },
    };
  }

  function install(win) {
    const page = new win.URL(win.location.href);
    if (win.top !== win || !['http:', 'https:'].includes(page.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(page.hostname)) return null;

    const socketUrl = `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/connect-websocket`;
    const socket = win.WebSocket?.prototype;
    const originalSend = socket?.send;
    const originalFetch = win.fetch;
    const decoder = new win.TextDecoder('utf-8', { fatal: true });
    const encoder = new win.TextEncoder();
    let active = true;

    function send(...args) {
      const data = args[0];
      if (active && typeof data === 'string' && data.includes(START_METHOD)) {
        try {
          if (this.url === socketUrl) {
            const frame = JSON.parse(data);
            if (frame.procedure === SEND && frame.type === 'start' && frame.stream === false) {
              const payload = withMediaBudget(frame.payload);
              if (payload !== frame.payload) args[0] = JSON.stringify({ ...frame, payload });
            }
          }
        } catch {}
      }
      return Reflect.apply(originalSend, this, args);
    }

    function fetch(...args) {
      const [input, init] = args;
      if (active && init?.method === 'POST' && init.body instanceof win.Uint8Array &&
          (typeof input === 'string' || input instanceof win.URL)) {
        try {
          const url = new win.URL(input, page);
          if (url.origin === page.origin && url.pathname === SEND && !url.search &&
              new win.Headers(init.headers).get('content-type') === 'application/grpc-web+json') {
            const body = init.body;
            // gRPC-Web unary JSON has exactly one uncompressed data frame.
            const header = new win.DataView(body.buffer, body.byteOffset, body.byteLength);
            if (body.length > 5 && body[0] === 0 && header.getUint32(1) === body.length - 5) {
              const payload = JSON.parse(decoder.decode(body.subarray(5)));
              const updated = withMediaBudget(payload);
              if (updated !== payload) {
                const json = encoder.encode(JSON.stringify(updated));
                const next = new win.Uint8Array(5 + json.length);
                new win.DataView(next.buffer).setUint32(1, json.length);
                next.set(json, 5);
                args[1] = { ...init, body: next };
              }
            }
          }
        } catch {}
      }
      return Reflect.apply(originalFetch, this, args);
    }

    if (typeof originalSend === 'function') {
      try { socket.send = send; } catch {}
    }
    if (typeof originalFetch === 'function') {
      try { win.fetch = fetch; } catch {}
    }
    return () => {
      active = false;
      try { if (socket?.send === send) socket.send = originalSend; } catch {}
      try { if (win.fetch === fetch) win.fetch = originalFetch; } catch {}
    };
  }

  return { install };
});
