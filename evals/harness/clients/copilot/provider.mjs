import http from 'node:http';

/** Scripted local inference only; requests still come from the unmodified native CLI. */
export async function createNativeProtocolFixture({
  onRequest, next, finalText = 'OFFLINE_FIXTURE_COMPLETE',
  maxRequests = 64, maxRequestBytes = 512 * 1024, callPrefix = 'fixture_call'
}) {
  const calls = [], errors = [];
  let turn = 0;
  const server = http.createServer((req, res) => {
    const chunks = []; let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxRequestBytes) { errors.push('REQUEST_LIMIT'); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
        calls.push({ unexpectedPath: req.url }); res.writeHead(404); res.end(); return;
      }
      try {
        if (turn >= maxRequests) throw new Error('REQUEST_LIMIT');
        const raw = Buffer.concat(chunks);
        const body = JSON.parse(raw.toString('utf8'));
        if (!Array.isArray(body.messages)) throw new Error('INVALID_REQUEST');
        const tools = (body.tools ?? []).map(tool => tool.function);
        onRequest({ body, tools, raw, turn, path: req.url });
        const step = next({ body, tools, turn }) ?? {};
        if (step.hang) return;
        if (step.status) {
          res.writeHead(step.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Synthetic authentication failure', type: 'authentication_error' } }));
          return;
        }
        const id = `${callPrefix}_${turn++}`;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
        const base = { id: `chatcmpl-${turn}`, object: 'chat.completion.chunk', created: 1, model: 'offline-fixture-model' };
        if (step.tool) {
          calls.push({ id, name: step.tool, arguments: step.args });
          emit({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
            { index: 0, id, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }
          ] }, finish_reason: null }] });
          emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          emit({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: finalText }, finish_reason: null }] });
          emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
        }
        res.end('data: [DONE]\n\n');
      } catch {
        errors.push('INVALID_OR_INCOMPLETE_PROTOCOL');
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"Invalid offline fixture request"}}');
      }
    });
    req.on('error', () => { errors.push('REQUEST_INTERRUPTED'); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8765, '127.0.0.1', resolve);
  });
  return { calls, errors, close: async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
