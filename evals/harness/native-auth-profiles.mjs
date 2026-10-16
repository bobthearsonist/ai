import { randomUUID } from 'node:crypto';
import { CLIENTS, ContractError } from './index.mjs';
import {
  cleanupAuthProfile, describeAuthProfile, planAuthCommands, prepareAuthProfile
} from './auth/index.mjs';

export function prepareNativeAuthProfiles({ clients = CLIENTS } = {}, {
  prepare = prepareAuthProfile, describe = describeAuthProfile,
  plan = planAuthCommands, cleanup = cleanupAuthProfile
} = {}) {
  if (!Array.isArray(clients) || clients.length === 0 ||
      new Set(clients).size !== clients.length || !clients.every(client => CLIENTS.includes(client))) {
    throw new ContractError('Auth preparation requires a nonempty unique supported client selection');
  }
  if (![prepare, describe, plan, cleanup].every(operation => typeof operation === 'function')) {
    throw new ContractError('Auth preparation operations must be functions');
  }
  const handles = [];
  try {
    const profiles = clients.map(client => {
      const handle = prepare({ client });
      handles.push(handle);
      return { profile: describe(handle), commands: plan(handle) };
    });
    return {
      handles,
      report: {
        invocationId: randomUUID(), createdAt: new Date().toISOString(),
        mode: 'preparation-only', authenticationVerified: false,
        liveAccepted: false, loginExecuted: false, clients: [...clients], profiles
      }
    };
  } catch (error) {
    const failures = [error];
    for (const handle of handles.toReversed()) {
      try { cleanup(handle); }
      catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures,
      `Auth preparation failed: ${error.message}; owned profile cleanup failed: ${failures.slice(1).map(item => item.message).join('; ')}`);
  }
}
