import db from '../../util/db';
import { Logger } from 'winston';
import env from '../../util/env';
import WorkItem, { getNextWorkItem } from '../../models/work-item';
import { getNextJobIdForUsernameAndService, getNextUsernameForWork, incrementRunningAndDecrementReadyCounts } from '../../models/user-work';
import { getQueueForUrl, getWorkSchedulerQueue  } from '../../util/queue/queue-factory';
import { QUERY_CMR_SERVICE_REGEX, calculateQueryCmrLimit } from './util';

export type WorkItemData = {
  workItem: WorkItem,
  maxCmrGranules?: number
};

/**
 * Get the next work item for the given service from the queue
 * @param serviceID - The service ID for which to get work
 */
export async function getWorkFromQueue(serviceID: string): Promise<WorkItemData> {
  const queueUrl = env.serviceQueueUrls[serviceID];
  if (!queueUrl) {
    throw new Error(`No queue URL found for service ${serviceID}`);
  }

  const queue = getQueueForUrl(queueUrl);
  if (!queue) {
    throw new Error(`No queue found for URL ${queueUrl}`);
  }

  // get a message from the service queue without using long-polling
  let queueItem = await queue.getMessage(0);
  if (!queueItem) {
    // put a message on the scheduler queue asking it to schedule some WorkItems for this service
    const schedulerQueue = getWorkSchedulerQueue();
    await schedulerQueue.sendMessage(serviceID);

    // long poll for work multiple times before giving up
    let count = 0;
    while (true) {
      queueItem = await queue.getMessage();
      count++;
      if (count === 3) {
        break;
      }
    }
  }

  if (queueItem){
    const item = JSON.parse(queueItem.body) as WorkItemData;
    return item;
  }

  return null;
}

/**
 *
 * @param serviceID - TODO
 * @param reqLogger - TODO
 * @param podName - TODO
 * @param res - TODO
 * @param responded - TODO
 * @returns
 */
export async function getWorkFromDatabase(serviceID: string, reqLogger: Logger): Promise<WorkItemData> {
  let result: WorkItemData;
  await db.transaction(async (tx) => {
    const username = await getNextUsernameForWork(tx, serviceID as string);
    if (username) {
      const jobID = await getNextJobIdForUsernameAndService(tx, serviceID as string, username);
      if (jobID) {
        const workItem = await getNextWorkItem(tx, serviceID as string, jobID);
        if (workItem) {
          await incrementRunningAndDecrementReadyCounts(tx, jobID, serviceID as string);

          if (workItem && QUERY_CMR_SERVICE_REGEX.test(workItem.serviceID)) {
            const logger = reqLogger.child({ workItemId: workItem.id });
            const maxCmrGranules = await calculateQueryCmrLimit(tx, workItem, logger);
            result = { workItem, maxCmrGranules };
          } else {
            result = { workItem };
          }
        } else {
          reqLogger.warn(`user_work is out of sync for user ${username} and job ${jobID}, could not find ready work item`);
        }
      }
    }
  });
  return result;
}