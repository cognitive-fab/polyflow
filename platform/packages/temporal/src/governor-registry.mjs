// Where workflow code finds its run's governor and ledger. Runs in the isolate.
//
// The interceptor owns both; `proposePlan` needs to consult the guard's state
// and write to the same ledger. Keyed by run id, because the TS SDK may share
// one module scope between workflow executions; each run registers itself at
// execute and removes itself at close.

const byRun = new Map();

export const registerGovernor = (runId, entry) => { byRun.set(runId, entry); };
export const forgetGovernor = (runId) => { byRun.delete(runId); };
export const governorOf = (runId) => byRun.get(runId) ?? null;
