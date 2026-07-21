import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { ILogGroup } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Create a Lambda execution role that grants only the minimal CloudWatch
 * Logs permissions scoped to a single pre-created log group.
 *
 * This is the in-house alternative to the AWS-managed
 * `AWSLambdaBasicExecutionRole` policy that `NodejsFunction` attaches by
 * default. That managed policy grants `logs:CreateLogGroup`,
 * `logs:CreateLogStream`, and `logs:PutLogEvents` against `*`, which trips
 * `AwsSolutions-IAM4`. Every Lambda in this stack already passes a
 * pre-created {@link ILogGroup} to `NodejsFunction.logGroup`, so the
 * `logs:CreateLogGroup` permission is unnecessary and the remaining two
 * actions can be scoped to that log group's ARN.
 *
 * Other permissions (S3, DynamoDB, Bedrock, etc.) are still granted by
 * the caller via the usual CDK grant helpers and `addToPolicy` calls
 * against the returned role.
 *
 * @param scope    Parent construct (typically the Lambda's owning construct)
 * @param id       Logical id for the role (e.g. `'ExecutionRole'`)
 * @param logGroup Pre-created log group the Lambda writes to
 */
export function createScopedLambdaRole(
  scope: Construct,
  id: string,
  logGroup: ILogGroup,
): Role {
  const role = new Role(scope, id, {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    description:
      'Lambda execution role with scoped CloudWatch Logs access (no AWS managed policies).',
  });

  // The Lambda runtime creates a new log stream per execution environment
  // and writes events to it. `logs:CreateLogGroup` is intentionally
  // omitted — the log group is pre-created by the construct.
  role.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${logGroup.logGroupArn}:*`],
    }),
  );

  return role;
}
