const messages = Object.freeze({
  INVALID_ARGUMENT: 'Invalid explicit egress boundary arguments',
  INVALID_HOST: 'A canonical exact DNS service identity is required',
  INVALID_POLICY: 'Invalid bounded service egress policy',
  LIVE_BOUNDARY_UNVERIFIED: 'Live admission remains blocked: public service compatibility and credential, authentication, and tool isolation are unverified',
  INVALID_HANDLE: 'An authentic process-owned egress boundary handle is required',
  CANDIDATE_STATE: 'The owned candidate lifecycle state does not permit this operation',
  CANDIDATE_SEED_INVALID: 'The process-owned candidate seed is unsupported or exceeds its finite limits',
  NATIVE_IMAGE_UNTRUSTED: 'An original active image handle from the exact native client owner is required',
  NATIVE_SEED_INVALID: 'Native staging cannot overlay its executable or contain credential/private-grading paths',
  TOOL_TRANSPORT_UNTRUSTED: 'An exact original tool task, worker, lease and binding tuple is required',
  TOOL_TRANSPORT_SCOPE_MISMATCH: 'The original tool transport task, client or tuple differs from the native candidate',
  TOOL_TRANSPORT_PIN_MISMATCH: 'The original tool worker protocol, fixed shim or socket contract differs from its pin',
  TOOL_TRANSPORT_EXPIRED: 'The original tool worker absolute deadline expired',
  TOOL_TRANSPORT_CLOSED: 'The original tool worker is closed, closing or unavailable',
  TOOL_TRANSPORT_CANCELLED: 'The original tool worker was cancelled',
  TOOL_TRANSPORT_UNVERIFIED: 'Fresh original tool worker kernel authority could not be established',
  TOOL_TRANSPORT_MOUNT_MISMATCH: 'The exact original socket-only readonly no-copy volume or supplemental group differs',
  TOOL_TRANSPORT_SOCKET_MISMATCH: 'The native consumer socket filesystem or primary identity differs from the original transport',
  OWNERSHIP_MISMATCH: 'Resource ownership or exact attachment identity differs from the owned boundary',
  RUNTIME_DRIFT: 'Observed Docker, Node or native client runtime differs from the required pin',
  IMAGE_UNAVAILABLE: 'The exact pinned image is not locally available; no image pull was attempted',
  DOCKER_UNAVAILABLE: 'The explicit local Docker engine is unavailable',
  DOCKER_FAILURE: 'The bounded local Docker operation failed',
  OUTPUT_LIMIT: 'Infrastructure output exceeded its finite byte limit',
  TIMEOUT: 'The finite infrastructure deadline expired',
  CANCELLED: 'The infrastructure operation was cancelled',
  PROCESS_STOP_UNVERIFIED: 'Termination of an owned helper process could not be verified',
  CLEANUP_FAILED: 'Exact owned resource cleanup could not be verified',
  CONFIG_MISMATCH: 'Observed container configuration differs from the required confinement',
  NETWORK_MISMATCH: 'Observed network topology differs from the owned egress boundary',
  MEASUREMENT_FAILED: 'An expected deterministic egress measurement was not established',
  CONNECT_OVERSIZE: 'CONNECT framing exceeds the supported bound',
  CONNECT_TRUNCATED: 'CONNECT framing ended before completion',
  CONNECT_METHOD: 'Only the supported CONNECT method is permitted',
  CONNECT_AUTHORITY: 'CONNECT requires an exact DNS authority on port 443',
  CONNECT_HEADERS: 'Unsupported or ambiguous CONNECT headers',
  CONNECT_PIPELINED: 'Pipelined CONNECT bytes are not supported',
  HOST_DENIED: 'The requested identity is outside the exact service policy',
  TLS_OVERSIZE: 'The initial TLS handshake exceeds the supported bound',
  TLS_TRUNCATED: 'The initial TLS handshake ended before completion',
  TLS_FRAMING: 'Unsupported or invalid initial TLS record framing',
  TLS_PIPELINED: 'Additional initial handshake or pipelined bytes are not supported',
  TLS_CLIENT_HELLO: 'A complete supported TLS ClientHello is required',
  TLS_SNI_REQUIRED: 'Exactly one plaintext canonical TLS server name is required',
  TLS_SNI_MISMATCH: 'CONNECT authority and TLS server name differ',
  TLS_ECH_UNSUPPORTED: 'Encrypted client or server-name handshakes are not supported',
  DNS_UNRESOLVED: 'Complete bounded DNS destination resolution was not established',
  DNS_NONPUBLIC: 'A destination answer is not an approved globally routable address',
  DNS_REBINDING: 'Complete repeated DNS answer sets differ',
  PEER_MISMATCH: 'The connected destination differs from the authorized numeric address',
  UPSTREAM_UNAVAILABLE: 'The authorized TLS destination could not be connected',
  CONNECTION_LIMIT: 'The finite relay connection limit was reached',
  INTERNAL_FAILURE: 'The boundary failed closed on an infrastructure error'
});

export class EgressBoundaryError extends Error {
  constructor(code = 'INTERNAL_FAILURE') {
    const stable = Object.hasOwn(messages, code) ? code : 'INTERNAL_FAILURE';
    super(messages[stable]);
    this.name = 'EgressBoundaryError';
    this.classification = 'infrastructure';
    this.code = stable;
  }
}

export function insist(condition, code) {
  if (!condition) throw new EgressBoundaryError(code);
}

export function sanitizedError(error) {
  return error instanceof EgressBoundaryError ? error : new EgressBoundaryError('INTERNAL_FAILURE');
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function isAborted(signal) {
  if (signal === undefined) return false;
  try { return Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal); }
  catch { throw new EgressBoundaryError('INVALID_ARGUMENT'); }
}

export function addAbortListener(signal, listener) {
  if (signal !== undefined) EventTarget.prototype.addEventListener.call(signal, 'abort', listener, { once: true });
}

export function removeAbortListener(signal, listener) {
  if (signal !== undefined && listener) EventTarget.prototype.removeEventListener.call(signal, 'abort', listener);
}

export const errorCodes = Object.freeze(Object.keys(messages));
