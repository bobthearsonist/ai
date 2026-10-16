import http from 'node:http';
import { spawn } from 'node:child_process';

export const SYNTHETIC_CANARY = 'synthetic-opencode-canary';

/** Only inference is scripted; tool execution and subsequent feedback belong to the native client. */
export function createScriptedServer({ next, maxRequestBytes = 1024 * 1024 }) {
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) throw new Error('Scripted request byte cap exceeded');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.method !== 'POST' || req.url !== '/v1/messages' ||
        req.headers['x-api-key'] !== SYNTHETIC_CANARY || body.model !== 'synthetic' || body.stream !== true) {
        throw new Error('Unexpected scripted endpoint, authentication, or model');
      }
      const { step, call, completionText = 'OFFLINE_FIXTURE_COMPLETE' } = next(body);
      const block = call
        ? { type: 'tool_use', id: `fixture_call_${step}`, name: call[0], input: call[1] }
        : { type: 'text', text: completionText };
      const message = { id: `msg_fixture_${step}`, type: 'message', role: 'assistant', model: 'synthetic',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message });
      send('content_block_start', { index: 0, content_block: block.type === 'tool_use'
        ? { ...block, input: {} } : { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: block.type === 'tool_use'
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 } });
      send('message_stop', {});
      res.end();
    } catch (error) {
      errors.push(error instanceof SyntaxError ? 'Malformed scripted request' : error.message);
      res.writeHead(400);
      res.end('Scripted fixture protocol failed');
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return { server, errors };
}

export function executeNative({ binary, args, cwd, env, input, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, detached: process.platform !== 'win32',
      shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let settled = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      if (error) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin?.destroy();
        child.unref();
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Native client timeout')), timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      sizes[stream] += chunk.length;
      if (sizes[stream] > (stream === 'stdout' ? 2 * 1024 * 1024 : 128 * 1024)) {
        finish(new Error('Native client output byte cap exceeded'));
      } else output[stream].push(chunk);
    });
    child.on('error', () => finish(new Error('Native client executable unavailable')));
    child.on('close', exitCode => finish(null, { exitCode,
      stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') }));
    if (input !== undefined) {
      child.stdin.on('error', () => finish(new Error('Native stdin delivery failed')));
      child.stdin.end(input);
    }
  });
}
