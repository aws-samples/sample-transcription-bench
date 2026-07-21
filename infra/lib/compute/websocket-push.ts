import { Duration, Stack } from 'aws-cdk-lib';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { createScopedLambdaRole } from './lambda-role';

export interface WebSocketPushProps {
  table: Table;
  webSocketEndpoint: string;
  /**
   * The WebSocket API id, used to scope the `execute-api:ManageConnections`
   * permission to this API only (AwsSolutions-IAM5 mitigation).
   */
  webSocketApiId: string;
}

export class WebSocketPush extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: WebSocketPushProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'WebSocketPushLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });

    // Custom execution role — see `lambda-role.ts` for rationale.
    const role = createScopedLambdaRole(this, 'ExecutionRole', logGroup);

    this.handler = new NodejsFunction(this, 'WebSocketPushFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/api/websocket-push.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
        WEBSOCKET_ENDPOINT: props.webSocketEndpoint,
      },
      logGroup,
      role,
      bundling: {
        forceDockerBundling: false,
      },
    });

    this.handler.addEventSource(
      new DynamoEventSource(props.table, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 1,
      })
    );

    props.table.grantReadWriteData(this.handler);

    this.handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['execute-api:ManageConnections'],
        // Scope to this WebSocket API only (AwsSolutions-IAM5).
        resources: [
          `arn:aws:execute-api:${Stack.of(this).region}:${Stack.of(this).account}:${props.webSocketApiId}/*`,
        ],
      })
    );
  }
}
