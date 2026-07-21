import { Duration } from 'aws-cdk-lib';
import { Runtime, IFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { createScopedLambdaRole } from './lambda-role';

export interface OrchestratorProps {
  table: Table;
  bucket: Bucket;
  /**
   * Worker Lambdas keyed by `ModelInfo.provider` (e.g. `bedrock`,
   * `sagemaker`, `transcribe`). The orchestrator looks up the Lambda for
   * each selected model by its provider name, so adding/removing workers
   * here cannot silently mis-route to the wrong function.
   */
  workerFunctions: Record<string, IFunction>;
}

export class Orchestrator extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: OrchestratorProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'OrchestratorLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });

    // Custom execution role — see `lambda-role.ts` for rationale.
    const role = createScopedLambdaRole(this, 'ExecutionRole', logGroup);

    this.handler = new NodejsFunction(this, 'OrchestratorFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/orchestrator/handler.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        WORKER_FUNCTION_ARNS: JSON.stringify(
          Object.fromEntries(
            Object.entries(props.workerFunctions).map(([provider, fn]) => [
              provider,
              fn.functionArn,
            ]),
          ),
        ),
      },
      logGroup,
      role,
      bundling: {
        forceDockerBundling: false,
      },
    });

    props.table.grantReadWriteData(this.handler);

    props.bucket.grantRead(this.handler);

    for (const workerFn of Object.values(props.workerFunctions)) {
      workerFn.grantInvoke(this.handler);
    }
  }
}
