/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */
/**
 * aws-organization-create-accounts - lambda handler
 *
 * @param event
 * @returns
 */

import { throttlingBackOff } from '@aws-accelerator/utils/lib/throttle';
import { CreateAccountResponse } from 'aws-sdk/clients/organizations';
import { getGlobalRegion, setRetryStrategy } from '@aws-accelerator/utils/lib/common-functions';
import { CloudFormationCustomResourceEvent, Context } from '@aws-accelerator/utils/lib/common-types';
import {
  CreateAccountCommand,
  CreateGovCloudAccountCommand,
  DescribeCreateAccountStatusCommand,
  DescribeCreateAccountStatusResponse,
  ListRootsCommand,
  MoveAccountCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';
import { AttributeValue, DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const newOrgAccountsTableName = process.env['NewOrgAccountsTableName'] ?? '';
const govCloudAccountMappingTableName = process.env['GovCloudAccountMappingTableName'] ?? '';
const accountRoleName = process.env['AccountRoleName'];
const solutionId = process.env['SOLUTION_ID'] ?? '';

interface AccountConfig {
  name: string;
  description: string;
  email: string;
  enableGovCloud: string;
  organizationalUnitId: string;
  createRequestId?: string;
}

type AccountConfigs = Array<AccountConfig>;
let organizationsClient: OrganizationsClient;
let documentClient: DynamoDBDocumentClient;

export async function handler(
  event: CloudFormationCustomResourceEvent,
  context: Context,
): Promise<
  | {
      IsComplete: boolean;
    }
  | undefined
> {
  console.log(event);
  const partition = context.invokedFunctionArn.split(':')[1];
  const globalRegion = getGlobalRegion(partition);
  organizationsClient = new OrganizationsClient({
    region: globalRegion,
    customUserAgent: solutionId,
    retryStrategy: setRetryStrategy(),
  });
  documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      customUserAgent: solutionId,
      retryStrategy: setRetryStrategy(),
    }),
  );

  // get a single accountConfig from table and attempt to create
  // if no record is returned then all new accounts are provisioned
  try {
    const accountToAdd = await getSingleAccountConfigFromTable();
    if (accountToAdd.length === 0) {
      console.log('Finished adding accounts');
      return {
        IsComplete: true,
      };
    }

    const singleAccountToAdd = accountToAdd[0];
    console.log(`enablegovcloud value: ${singleAccountToAdd.enableGovCloud}`);
    let createAccountResponse: CreateAccountResponse;
    // if the createRequestId is empty then we need to create the account
    if (singleAccountToAdd.createRequestId === '' || singleAccountToAdd.createRequestId === undefined) {
      if (singleAccountToAdd.enableGovCloud == 'true' || singleAccountToAdd.enableGovCloud) {
        createAccountResponse = await createGovCloudAccount(singleAccountToAdd.email, singleAccountToAdd.name);
      } else {
        createAccountResponse = await createOrganizationAccount(singleAccountToAdd.email, singleAccountToAdd.name);
      }
      switch (createAccountResponse.CreateAccountStatus?.State) {
        case 'IN_PROGRESS':
          console.log(`Initiated account creation for ${accountToAdd[0].email}`);
          singleAccountToAdd.createRequestId = createAccountResponse.CreateAccountStatus.Id;
          const updateAccountConfigResponse = await updateAccountConfig(singleAccountToAdd);
          if (!updateAccountConfigResponse) {
            throw new Error('Unable to update DynamoDB account record with request id');
          } else {
            return {
              IsComplete: false,
            };
          }
        case 'SUCCEEDED':
          if (createAccountResponse.CreateAccountStatus.GovCloudAccountId) {
            console.log(
              `GovCloud account created with id ${createAccountResponse.CreateAccountStatus.GovCloudAccountId}`,
            );
            await saveGovCloudAccountMapping(
              createAccountResponse.CreateAccountStatus.AccountId!,
              createAccountResponse.CreateAccountStatus.GovCloudAccountId,
              createAccountResponse.CreateAccountStatus.AccountName!,
            );
          }
          console.log(
            `Account with id ${createAccountResponse.CreateAccountStatus.AccountId} was created for email ${singleAccountToAdd.email}`,
          );
          await moveAccountToOrgIdFromRoot(
            createAccountResponse.CreateAccountStatus.AccountId!,
            singleAccountToAdd.organizationalUnitId,
          );
          await deleteSingleAccountConfigFromTable(singleAccountToAdd.email);
          break;
        default:
          throw new Error(
            `Could not create account ${singleAccountToAdd.email}. Response state: ${createAccountResponse.CreateAccountStatus?.State}. Failure reason: ${createAccountResponse.CreateAccountStatus?.FailureReason}`,
          );
      }
    } else {
      // check status of account creation
      const createAccountStatusResponse = await getAccountCreationStatus(singleAccountToAdd.createRequestId);
      switch (createAccountStatusResponse.CreateAccountStatus?.State) {
        case 'IN_PROGRESS':
          console.log(`Account is still being created`);
          return {
            IsComplete: false,
          };
        case 'SUCCEEDED':
          console.log(`Account with id ${createAccountStatusResponse.CreateAccountStatus?.AccountId} is complete`);
          if (createAccountStatusResponse.CreateAccountStatus.GovCloudAccountId) {
            console.log(createAccountStatusResponse.CreateAccountStatus.GovCloudAccountId);
            await saveGovCloudAccountMapping(
              createAccountStatusResponse.CreateAccountStatus.AccountId!,
              createAccountStatusResponse.CreateAccountStatus.GovCloudAccountId,
              singleAccountToAdd.name,
            );
          }
          await moveAccountToOrgIdFromRoot(
            createAccountStatusResponse.CreateAccountStatus.AccountId!,
            singleAccountToAdd.organizationalUnitId,
          );
          await deleteSingleAccountConfigFromTable(singleAccountToAdd.email);
          break;
        default:
          throw new Error(
            `Could not create account ${singleAccountToAdd.email}. Response state: ${createAccountStatusResponse.CreateAccountStatus?.State}, Failure reason: ${createAccountStatusResponse.CreateAccountStatus?.FailureReason}`,
          );
      }
    }
    return {
      IsComplete: false,
    };
  } catch (e) {
    console.log(e);
    console.log(`Create accounts failed. Deleting pending account creation records`);
    await deleteAllRecordsFromTable(newOrgAccountsTableName);
    throw new Error(`Account creation failed. ${e}`);
  }
}

async function getSingleAccountConfigFromTable(): Promise<AccountConfigs> {
  const accountToAdd: AccountConfigs = [];
  const scanParams = {
    TableName: newOrgAccountsTableName,
    Limit: 1,
  };
  const response = await throttlingBackOff(() => documentClient.send(new ScanCommand(scanParams)));
  console.log(`getSingleAccount response ${JSON.stringify(response)}`);
  const itemCount = response.Items?.length ?? 0;

  if (itemCount > 0) {
    const accountConfigAttributeValue: AttributeValue = response.Items![0]['accountConfig'];
    if (typeof accountConfigAttributeValue === 'string') {
      const account: AccountConfig = JSON.parse(accountConfigAttributeValue);
      accountToAdd.push(account);
      console.log(`Account to add ${JSON.stringify(accountToAdd)}`);
    }
  }
  return accountToAdd;
}

async function deleteSingleAccountConfigFromTable(accountToDeleteEmail: string): Promise<boolean> {
  const deleteParams = {
    TableName: newOrgAccountsTableName,
    Key: {
      accountEmail: accountToDeleteEmail,
    },
  };
  const response = await throttlingBackOff(() => documentClient.send(new DeleteCommand(deleteParams)));
  if (response.$metadata.httpStatusCode === 200) {
    return true;
  } else {
    console.log(response);
    return false;
  }
}

async function createOrganizationAccount(accountEmail: string, accountName: string): Promise<CreateAccountResponse> {
  const createAccountsParams = {
    AccountName: accountName,
    Email: accountEmail,
    RoleName: accountRoleName,
  };
  const createAccountResponse = await throttlingBackOff(() =>
    organizationsClient.send(new CreateAccountCommand(createAccountsParams)),
  );
  console.log(createAccountResponse);
  return createAccountResponse;
}

async function createGovCloudAccount(accountEmail: string, accountName: string): Promise<CreateAccountResponse> {
  const createAccountsParams = {
    AccountName: accountName,
    Email: accountEmail,
    RoleName: accountRoleName,
  };
  const createAccountResponse = await throttlingBackOff(() =>
    organizationsClient.send(new CreateGovCloudAccountCommand(createAccountsParams)),
  );
  console.log(createAccountResponse);
  return createAccountResponse;
}

async function getAccountCreationStatus(requestId: string): Promise<DescribeCreateAccountStatusResponse> {
  return await throttlingBackOff(() =>
    organizationsClient.send(new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: requestId })),
  );
}

async function updateAccountConfig(accountConfig: AccountConfig): Promise<boolean> {
  const params = {
    TableName: newOrgAccountsTableName,
    Item: {
      accountEmail: accountConfig.email,
      accountConfig: JSON.stringify(accountConfig),
    },
  };
  const response = await throttlingBackOff(() => documentClient.send(new PutCommand(params)));
  if (response.$metadata.httpStatusCode === 200) {
    return true;
  } else {
    console.log(response);
    return false;
  }
}

async function moveAccountToOrgIdFromRoot(accountId: string, orgId: string): Promise<boolean> {
  const roots = await throttlingBackOff(() => organizationsClient.send(new ListRootsCommand({})));
  const rootOrg = roots.Roots?.find(item => item.Name === 'Root');
  const response = await throttlingBackOff(() =>
    organizationsClient.send(
      new MoveAccountCommand({
        AccountId: accountId,
        DestinationParentId: orgId,
        SourceParentId: rootOrg!.Id!,
      }),
    ),
  );
  if (response.$metadata.httpStatusCode === 200) {
    console.log(`Moved account ${accountId} to OU.`);
    return true;
  } else {
    console.log(
      `Failed to move account ${accountId} to OU. Move request status code: ${response.$metadata.httpStatusCode}`,
    );
  }
  return false;
}

async function saveGovCloudAccountMapping(
  commercialAccountId: string,
  govCloudAccountId: string,
  accountName: string,
): Promise<boolean> {
  const params = {
    TableName: govCloudAccountMappingTableName,
    Item: {
      commercialAccountId: commercialAccountId,
      govCloudAccountId: govCloudAccountId,
      accountName: accountName,
    },
  };
  const response = await throttlingBackOff(() => documentClient.send(new PutCommand(params)));
  if (response.$metadata.httpStatusCode === 200) {
    return true;
  } else {
    console.log(response);
    return false;
  }
}

async function deleteAllRecordsFromTable(paramTableName: string) {
  const params = {
    TableName: paramTableName,
    ProjectionExpression: 'accountEmail',
  };
  const response = await throttlingBackOff(() => documentClient.send(new ScanCommand(params)));
  if (response.Items) {
    for (const item of response.Items) {
      console.log(item['accountEmail']);
      const itemParams = {
        TableName: paramTableName,
        Key: {
          accountEmail: item['accountEmail'],
        },
      };
      await throttlingBackOff(() => documentClient.send(new DeleteCommand(itemParams)));
    }
  }
}
