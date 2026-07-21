import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { createScopedLambdaRole } from '../compute/lambda-role';

export interface TranscribeWorkerProps {
  table: Table;
  bucket: Bucket;
}

export class TranscribeWorker extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: TranscribeWorkerProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'TranscribeWorkerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });

    // Custom execution role — see `lambda-role.ts` for rationale.
    const role = createScopedLambdaRole(this, 'ExecutionRole', logGroup);

    this.handler = new NodejsFunction(this, 'TranscribeWorkerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/workers/transcribe/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(300),
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
      },
      logGroup,
      role,
      bundling: {
        forceDockerBundling: false,
      },
    });

    this.handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'transcribe:StartTranscriptionJob',
          'transcribe:GetTranscriptionJob',
        ],
        resources: ['*'],
      })
    );

    props.bucket.grantReadWrite(this.handler);
    props.table.grantWriteData(this.handler);
  }
}
