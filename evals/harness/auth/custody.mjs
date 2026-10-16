import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { hashObject } from '../index.mjs';
import { CLIENT_VERSIONS } from '../isolation/index.mjs';
import { describeLiveEvaluation } from '../live-execution.mjs';
import {
  AuthError, cleanupAuthProfile, describeAuthProfile, prepareAuthProfile
} from './index.mjs';

const custodians = new WeakMap();
const blockers = Object.freeze([
  'Native login has not been executed or observed in an isolated admitted runtime.',
  'Pinned Linux native credential storage, account-status semantics and refresh lifecycle are unverified.',
  'Windows/macOS host keychains, personal HOME/config and gh fallback cannot be imported.',
  'Native login/refresh endpoint and egress-boundary proxy compatibility have not been verified.',
  'Root native-runtime credential access must be separated from evaluation-tool filesystem/environment access.',
  'Exact operator-issued auth authorization, runtime image/spec admission and account-consuming execution authorization remain separate prerequisites.'
]);

function check(condition, code, message) {
  if (!condition) throw new AuthError(code, message);
}

function explicit(value, keys) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(item => Object.hasOwn(item, 'value')),
  'INVALID_CUSTODY_OPTIONS', 'Only explicit native auth custody coordinates are supported');
}

function evaluationReport(evaluation, client) {
  check(typeof client === 'string' && Object.hasOwn(CLIENT_VERSIONS, client),
    'UNSUPPORTED_CLIENT', 'Unsupported native auth client');
  let report;
  try { report = describeLiveEvaluation(evaluation); }
  catch { throw new AuthError('INVALID_AUTH_EVALUATION', 'Original active live-evaluation preparation handle required'); }
  check(report.selection.clients.includes(client) && report.requestedRoutes[client]?.clientVersion === CLIENT_VERSIONS[client],
    'AUTH_BINDING_MISMATCH', 'Native auth custody client is not selected by this exact evaluation');
  return report;
}

function binding(report, client) {
  const route = report.requestedRoutes[client];
  return Object.freeze({
    invocationId: report.invocationId, planHash: report.planHash, profileHash: report.profileHash,
    client, clientVersion: route.clientVersion, model: route.model, endpoint: route.endpoint,
    requestedImage: report.requestedImage, taskSessionCount: report.taskSessionCount
  });
}

function pristine(state) {
  let profile;
  try {
    profile = describeAuthProfile(state.profile);
    for (const directory of Object.values(profile.paths)) {
      check(fs.readdirSync(directory).length === 0,
        'AUTH_STORAGE_UNVERIFIED', 'Unexpected native auth storage; no credential imports or caller auth evidence are accepted');
    }
    const expected = ['.owner.json', ...Object.values(profile.paths).map(directory => path.basename(directory))].sort();
    check(JSON.stringify(fs.readdirSync(profile.directory).sort()) === JSON.stringify(expected),
      'AUTH_STORAGE_UNVERIFIED', 'Unexpected native auth profile entries');
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('AUTH_CUSTODY_OWNERSHIP', 'Cannot verify private native auth custody');
  }
  return profile;
}

function owned(handle, { validateEvaluation = true } = {}) {
  check(handle && !types.isProxy(handle), 'INVALID_AUTH_CUSTODY', 'Original active native auth custody handle required');
  const state = custodians.get(handle);
  check(state && !state.released, 'INVALID_AUTH_CUSTODY', 'Original active native auth custody handle required');
  if (validateEvaluation) {
    const current = binding(evaluationReport(state.evaluation, state.client), state.client);
    check(hashObject(current) === state.bindingHash, 'AUTH_BINDING_MISMATCH', 'Native auth evaluation binding changed');
  }
  pristine(state);
  return state;
}

function publicDescription(state) {
  return Object.freeze({
    kind: 'isolated-native-auth-custody', id: state.id, client: state.client,
    phase: 'prepared-unverified', binding: state.binding, bindingHash: state.bindingHash,
    configured: true, nativeRuntimeVerified: false, authenticationVerified: false, nativeLoginExecuted: false,
    nativeStatusObserved: false, credentialsImported: false, credentialStorageVerified: false,
    refreshVerified: false, rootRuntimeAccessVerified: false, evaluationToolAccessVerified: false,
    candidateAttachmentSupported: false, liveAccepted: false, blockers
  });
}

export function prepareNativeAuthCustody(input) {
  explicit(input, ['client', 'evaluation']);
  const report = evaluationReport(input.evaluation, input.client);
  const exactBinding = binding(report, input.client);
  const profile = prepareAuthProfile({ client: input.client });
  const state = {
    id: randomUUID(), client: input.client, evaluation: input.evaluation,
    binding: exactBinding, bindingHash: hashObject(exactBinding), profile, released: false
  };
  try {
    pristine(state);
    const handle = Object.freeze({ id: state.id, client: state.client });
    custodians.set(handle, state);
    return handle;
  } catch (error) {
    try { cleanupAuthProfile(profile); }
    catch { throw new AuthError('AUTH_CUSTODY_CLEANUP_FAILED', 'Failed preparation could not safely release owned native auth custody'); }
    throw error;
  }
}

export function describeNativeAuthCustody(handle) {
  return publicDescription(owned(handle));
}

export function assertNativeAuthCustody(handle, input) {
  explicit(input, ['evaluation', 'client']);
  const state = owned(handle);
  check(input.evaluation === state.evaluation && input.client === state.client,
    'AUTH_BINDING_MISMATCH', 'Native auth custody belongs to a different original evaluation/client');
  return publicDescription(state);
}

export function requireNativeAuthenticatedCustody(handle, input) {
  assertNativeAuthCustody(handle, input);
  throw new AuthError('AUTHENTICATION_UNVERIFIED',
    'Native authentication has not been observed in the admitted isolated runtime; custody cannot authorize attachment or execution');
}

export function releaseNativeAuthCustody(handle) {
  const state = owned(handle, { validateEvaluation: false });
  // Release does not depend on the evaluation still being active, and never logs out host accounts.
  cleanupAuthProfile(state.profile);
  state.released = true;
  custodians.delete(handle);
}
