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

import { DEFAULT_LAMBDA_RUNTIME } from '@aws-accelerator/utils/lib/lambda';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as path from 'path';

/**
 * Initialized VpcIdLookupProps properties
 */
export interface VpcIdLookupProps {
  /**
   * Vpc name
   */
  readonly vpcName: string;
  /**
   * Custom resource lambda key, when undefined default AWS managed key will be used
   */
  readonly lambdaKey?: cdk.aws_kms.IKey;
  /**
   * Custom resource CloudWatch log group encryption key, when undefined default AWS managed key will be used
   */
  readonly cloudwatchKey?: cdk.aws_kms.IKey;
  /**
   * Custom resource CloudWatch log retention in days
   */
  readonly cloudwatchLogRetentionInDays: number;
}

/**
 * Vpc id lookup class.
 */
export class VpcIdLookup extends Construct {
  public readonly vpcId: string;
  constructor(scope: Construct, id: string, props: VpcIdLookupProps) {
    super(scope, id);

    const providerLambda = new cdk.aws_lambda.Function(this, 'VpcIdLookupFunction', {
      code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, 'get-vpc-id/dist')),
      runtime: DEFAULT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      description: 'Lookup vpc id from account',
      environmentEncryption: props.lambdaKey,
    });

    providerLambda.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'Ec2Actions',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['ec2:DescribeVpcs'],
        resources: ['*'],
      }),
    );

    // Custom resource lambda log group
    const logGroup = new cdk.aws_logs.LogGroup(this, `${providerLambda.node.id}LogGroup`, {
      logGroupName: `/aws/lambda/${providerLambda.functionName}`,
      retention: props.cloudwatchLogRetentionInDays,
      encryptionKey: props.cloudwatchKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const provider = new cdk.custom_resources.Provider(this, 'VpcIdLookupProvider', {
      onEventHandler: providerLambda,
    });

    const resource = new cdk.CustomResource(this, 'Resource', {
      resourceType: 'Custom::VpcIdLookup',
      serviceToken: provider.serviceToken,
      properties: {
        vpcName: props.vpcName,
      },
    });
    // Ensure that the LogGroup is created by Cloudformation prior to Lambda execution
    resource.node.addDependency(logGroup);
    this.vpcId = resource.ref;
  }
}
