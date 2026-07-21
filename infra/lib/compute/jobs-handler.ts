import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { createScopedLambdaRole } from './lambda-role';

export interface JobsHandlerProps {
  table: Table;
  bucket: Bucket;
}

export class JobsHandler extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: JobsHandlerProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'JobsHandlerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });

    // Custom execution role with logs permissions scoped to `logGroup` —
    // avoids the AWS-managed `AWSLambdaBasicExecutionRole` (AwsSolutions-IAM4).
    const role = createScopedLambdaRole(this, 'ExecutionRole', logGroup);

    this.handler = new NodejsFunction(this, 'JobsHandlerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/api/jobs-handler.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
        AUDIO_BUCKET_NAME: props.bucket.bucketName,
      },
      logGroup,
      role,
      bundling: {
        forceDockerBundling: false,
      },
    });

    props.table.grantReadWriteData(this.handler);
    props.bucket.grantRead(this.handler);
  }
}
