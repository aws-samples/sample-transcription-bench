import { Duration, Stack } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { createScopedLambdaRole } from '../compute/lambda-role';

export interface SageMakerWorkerProps {
  table: Table;
  bucket: Bucket;
  /** Map of catalog modelId -> SageMaker endpoint name */
  endpointNames: Record<string, string>;
}

export class SageMakerWorker extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: SageMakerWorkerProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'SageMakerWorkerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });

    // Custom execution role — see `lambda-role.ts` for rationale.
    const role = createScopedLambdaRole(this, 'ExecutionRole', logGroup);

    this.handler = new NodejsFunction(this, 'SageMakerWorkerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/workers/sagemaker/index.ts',
      handler: 'handler',
      // Lambda timeout > endpoint TorchServe timeout (600 s, set on the
      // SageMakerByocEndpoints construct for Whisper) so the Lambda can
      // capture the inference response or a clean 500 from TorchServe
      // before being killed. 15 min is the AWS Lambda hard maximum.
      timeout: Duration.seconds(900),
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        SAGEMAKER_ENDPOINT_MAP: JSON.stringify(props.endpointNames),
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
        actions: ['sagemaker:InvokeEndpoint'],
        // Scope to the specific endpoints this worker is allowed to invoke
        // (AwsSolutions-IAM5). Endpoint names are CloudFormation tokens so
        // this resolves to per-endpoint ARNs in the synthesized template.
        resources: Object.values(props.endpointNames).map(
          (name) =>
            `arn:aws:sagemaker:${Stack.of(this).region}:${Stack.of(this).account}:endpoint/${name}`,
        ),
      })
    );

    props.bucket.grantRead(this.handler);
    props.table.grantWriteData(this.handler);
  }
}
