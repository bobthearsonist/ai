import { TASK_CAPS, taskKeys, taskPath, insistTask } from './task-boundary.mjs';

export function nativeBrokerOptions(options) {
  taskKeys(options, ['model', 'limits', 'authRoot', 'proxyURL', 'toolTransport'], ['model', 'authRoot', 'proxyURL']);
  const { model, authRoot } = options;
  insistTask(typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model) &&
    !/offline|synthetic|mock/i.test(model), 'NATIVE_MODEL_REQUIRED',
  'A literal broker-selected native model is required; this does not admit it');
  insistTask(typeof authRoot === 'string' && authRoot.startsWith('/client-config/') &&
    taskPath(authRoot.slice('/client-config/'.length)) === authRoot.slice('/client-config/'.length),
  'NATIVE_AUTH_ROOT_REQUIRED', 'Only an isolated broker-owned native configuration root is referenced');
  const limits = options.limits === undefined ? {} : options.limits;
  taskKeys(limits, ['timeoutMs', 'nativeOutputBytes'], []);
  const timeoutMs = limits.timeoutMs === undefined ? 180000 : limits.timeoutMs;
  const nativeOutputBytes = limits.nativeOutputBytes === undefined ? TASK_CAPS.nativeOutputBytes : limits.nativeOutputBytes;
  insistTask(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= TASK_CAPS.timeoutMs &&
    Number.isInteger(nativeOutputBytes) && nativeOutputBytes >= 1024 &&
    nativeOutputBytes <= TASK_CAPS.nativeOutputBytes, 'TASK_LIMIT');
  const value = options.proxyURL;
  insistTask(typeof value === 'string' && value.length <= 256, 'NATIVE_PROXY_REQUIRED');
  let url;
  try { url = new URL(value); } catch { insistTask(false, 'NATIVE_PROXY_REQUIRED'); }
  insistTask(url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname === '/' && url.port && Number(url.port) >= 1 && Number(url.port) <= 65535 &&
    /^[a-zA-Z0-9.-]+$/.test(url.hostname), 'NATIVE_PROXY_REQUIRED',
  'An explicit credential-free broker HTTP CONNECT endpoint is required, not a provider URL');
  const parts = url.hostname.split('.');
  const address = parts.length === 4 && parts.every(part => /^\d+$/.test(part) && Number(part) <= 255);
  const privateAddress = address && (parts[0] === '127' || parts[0] === '10' ||
    parts[0] === '192' && parts[1] === '168' || parts[0] === '172' &&
      Number(parts[1]) >= 16 && Number(parts[1]) <= 31);
  insistTask(privateAddress || /^[a-zA-Z][a-zA-Z0-9-]{0,99}$/.test(url.hostname),
    'NATIVE_PROXY_REQUIRED', 'Only a local/private broker endpoint or internal Docker service name is referenced');
  return { model, authRoot, proxyURL: url.origin, limits: { timeoutMs, nativeOutputBytes } };
}

export function nativeEnvironment({ authRoot, proxyURL }) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/eval', COPILOT_HOME: authRoot,
    XDG_CACHE_HOME: '/opt/copilot-cache/.cache', XDG_CONFIG_HOME: '/client-config/xdg',
    XDG_DATA_HOME: '/client-config/data', XDG_STATE_HOME: '/client-config/state', TMPDIR: '/scratch',
    HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, ALL_PROXY: proxyURL, NO_PROXY: '',
    http_proxy: proxyURL, https_proxy: proxyURL, all_proxy: proxyURL, no_proxy: ''
  };
}
