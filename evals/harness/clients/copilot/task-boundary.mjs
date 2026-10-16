export const TASK_CAPS = Object.freeze({
  promptBytes: 16384, files: 24, fileBytes: 8192, inputBytes: 65536,
  artifacts: 8, artifactBytes: 8192, outputBytes: 32768,
  checks: 64, declarationBytes: 262144, payloadBytes: 262144,
  requests: 64, requestBytes: 524288, nativeOutputBytes: 393216,
  timeoutMs: 300000
});

export class CopilotTaskError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CopilotTaskError';
    this.code = code;
    this.failureClass = 'infrastructure';
  }
}

export function insistTask(condition, code, message = code) {
  if (!condition) throw new CopilotTaskError(code, message);
}

export function plainTaskObject(value) {
  return value !== null && typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype;
}

export function taskKeys(value, allowed, required = allowed) {
  insistTask(plainTaskObject(value) && Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key)), 'TASK_INPUT_INVALID');
}

export function taskPath(value) {
  insistTask(typeof value === 'string' && value.length > 0 && value.length <= 240,
    'TASK_PATH_INVALID');
  const parts = value.replaceAll('\\', '/').split('/');
  insistTask(parts.length <= 8 && parts.every(part =>
    part.length > 0 && part.length <= 100 && part !== '.' && part !== '..' &&
    /^[a-zA-Z0-9._ -]+$/.test(part) && !/[. ]$/.test(part) &&
    !/^(?:con|conin|conout|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
  ), 'TASK_PATH_INVALID', 'A portable literal relative file path is required');
  return parts.join('/');
}

export function taskContextDocument(relative) {
  return /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|copilot-instructions\.md|local\.yaml)$/i.test(relative);
}

export function protectedTaskPath(relative, { output = false } = {}) {
  const parts = relative.split('/');
  if (parts.some(part =>
    /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|auth\.json|\.credentials\.json|credentials(?:\..*)?|id_rsa|id_ed25519|hosts\.json|judge|grader|private|specimens(?:\..*)?|expected(?:\..*)?|answer[-_]keys?(?:\..*)?)$/i.test(part)
  )) return true;
  const root = parts[0];
  return /^(?:\.boundary|\.github|\.git|\.claude|\.claude-plugin|\.copilot|\.opencode|\.cline|\.config|\.local|\.vscode|\.mcp\.json|mcp\.json|opencode\.jsonc?|copilot\.jsonc?|copilot\.config\.jsonc?|settings(?:\.local)?\.json)$/i.test(root) ||
    output && parts.length === 1 && taskContextDocument(relative);
}

export function claimTaskPath(paths, root, relative) {
  const key = `${root}/${relative.toLowerCase()}`;
  insistTask(![...paths].some(existing => existing === key ||
    existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`)),
  'TASK_PATH_COLLISION', 'File paths must not alias or collide with seeds or outputs');
  paths.add(key);
}

export function taskText(content, maxBytes, { nonempty = false } = {}) {
  insistTask(typeof content === 'string' || Buffer.isBuffer(content), 'TASK_BYTES_REQUIRED',
    'Only explicitly supplied string or Buffer bytes are accepted');
  const bytes = Buffer.from(content);
  insistTask(bytes.length <= maxBytes, 'TASK_LIMIT');
  const text = bytes.toString('utf8');
  insistTask(Buffer.from(text).equals(bytes) && (typeof content !== 'string' || content === text) && !text.includes('\0'),
    'TASK_BINARY_UNSUPPORTED', 'This offline native text fixture requires valid UTF-8 without NUL');
  insistTask(!nonempty || text.trim().length > 0, 'TASK_INPUT_INVALID');
  return { text, bytes };
}

export function freezeTask(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTask(child);
    Object.freeze(value);
  }
  return value;
}
