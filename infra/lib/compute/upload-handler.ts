import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { createScopedLambdaRole } from './lambda-role';

export interface UploadHandlerProps {
  bucket: Bucket;
}

export class UploadHandler extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: UploadHandlerProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'UploadHandlerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });

    // Custom execution role — see `lambda-role.ts` for rationale.
    const role = createScopedLambdaRole(this, 'ExecutionRole', logGroup);

    this.handler = new NodejsFunction(this, 'UploadHandlerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/api/upload-handler.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: {
        BUCKET_NAME: props.bucket.bucketName,
      },
      logGroup,
      role,
      bundling: {
        forceDockerBundling: false,
      },
    });

    props.bucket.grantPut(this.handler);
  }
}
