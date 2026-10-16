/** The local fixture speaks the native Anthropic HTTP/SSE protocol, not a grader protocol. */
export function scriptedMessage(response, request, { content, index, prefix = 'offline' }) {
  const tool = content[0]?.type === 'tool_use';
  const message = { id: `msg_${prefix}_${index}`, type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-6', content, stop_reason: tool ? 'tool_use' : 'end_turn',
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!request.stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  content.forEach((block, blockIndex) => {
    event('content_block_start', { index: blockIndex, content_block: block.type === 'tool_use'
      ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: blockIndex, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { index: blockIndex });
  });
  event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {});
  response.end();
}
