import { createMysqlOperatorRepo } from '../../src/modules/identity/repos/operatorRepo.js';
import { systemClock } from '../../src/platform/clock.js';
import { describeOperatorRepoContract } from '../support/operatorRepoContract.js';
import { createIntegrationContext } from './support/context.js';

describeOperatorRepoContract('mysql', async () => {
  const ctx = await createIntegrationContext();
  return { repo: createMysqlOperatorRepo(ctx.db, systemClock), teardown: () => ctx.close() };
});
