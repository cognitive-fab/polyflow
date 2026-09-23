// The machine's orders, as activities. Each order kind is an activity of the
// same name, and the seven the sample defines are the sample's own: the
// bounded-context clients (clients/index.ts) wrapped by createActivities
// (activities.ts), both byte for byte upstream's, loaded as is. The payload of
// an order IS the sample's command, so no adapter is needed.
//
// `addKycCheck` is v2's new step; it does not exist in the sample.
import { createActivities } from './activities';
import { createClients } from './clients';
import { log } from '@temporalio/activity';

export async function makeActivities() {
  const sample = createActivities(await createClients());
  return {
    ...sample,
    async addKycCheck(params) {
      if (params.shouldThrow) throw new Error(params.shouldThrow);
      log.info('KYC CHECK', { params });
    },
  };
}
