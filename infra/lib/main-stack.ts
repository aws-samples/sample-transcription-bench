import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';

import { DeploymentConfig } from '../bin/context';
import { JobTable } from './storage/job-table';
import { AudioBucket } from './storage/audio-bucket';
import { CognitoAuth } from './auth/cognito';
import { TestUser } from './auth/test-user';
import { UploadHandler } from './compute/upload-handler';
import { Orchestrator } from './compute/orchestrator';
import { JobsHandler } from './compute/jobs-handler';
import { WebSocketPush } from './compute/websocket-push';
import { Evaluator } from './compute/evaluator';
import { createScopedLambdaRole } from './compute/lambda-role';
import { BedrockWorker } from './ai/bedrock-worker';
import { SageMakerByocEndpoints } from './ai/sagemaker-byoc-endpoints';
import { SageMakerWorker } from './ai/sagemaker-worker';
import { TranscribeWorker } from './ai/transcribe-worker';
import { RestApiGateway } from './api/rest-api';
import { WebSocketApi } from './api/websocket-api';
import { Monitoring } from './observability/monitoring';

export interface MainStackProps extends StackProps {
  /**
   * Resolved deployment configuration. Fully consumed in Task 4.2; declared
   * here so `infra/bin/app.ts` can pass it through without breaking the build.
   */
  deploymentConfig: DeploymentConfig;
}

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    // --- Storage ---
    const jobTable = new JobTable(this, 'JobTable');
    const audioBucket = new AudioBucket(this, 'AudioBucket');

    // --- Auth ---
    const auth = new CognitoAuth(this, 'CognitoAuth', {
      userPoolName: props.deploymentConfig.userPoolName,
    });
    const testUser = new TestUser(this, 'TestUser', {
      userPool: auth.userPool,
    });

    // --- AI Workers ---
    const bedrockWorker = new BedrockWorker(this, 'BedrockWorker', {
      table: jobTable.table,
      bucket: audioBucket.bucket,
    });

    const transcribeWorker = new TranscribeWorker(this, 'TranscribeWorker', {
      table: jobTable.table,
      bucket: audioBucket.bucket,
    });

    // SageMaker BYOC endpoints. Both Distil-Whisper Large v3 and Qwen3
    // ASR are hosted as BYOC so the container does not depend on a
    // runtime HuggingFace download (HF rate-limits anonymous traffic
    // from shared SageMaker egress IPs). Each model's model.tar.gz must
    // be uploaded ahead of time by `scripts/upload-sagemaker-artifacts.sh`.
    //
    // Whisper note: the S3 key `whisper-large-v3/` and the endpoint
    // construct name `WhisperLargeV3` are retained for backwards
    // compatibility with existing job records and catalog modelIds. The
    // served model is `distil-whisper/distil-large-v3` (English-only,
    // ~6x faster than the original), chosen to finish inference within
    // SageMaker's real-time synchronous 60 s InvokeEndpoint cap on the
    // ml.g6.xlarge L4 GPU. Swap the HF repo ID in the upload script to
    // revert to `openai/whisper-large-v3` if multilingual is needed.
    //
    // Cost note: each endpoint runs continuously and bills by the hour
    // (see `MODEL_CATALOG.instanceHourlyRateUsd`). If you don't need them,
    // delete this block and pass `--skip-sagemaker` to scripts/deploy.sh.
    // The `MODEL_TARBALL_ETAG` env vars are how CFN detects artifact
    // changes: PrimaryContainer on `AWS::SageMaker::Model` is immutable,
    // so putting the S3 ETag in the container env makes any tarball
    // change look like a template diff. CFN then replaces the Model,
    // cascade-replaces the EndpointConfig, and blue/green rolls the
    // endpoint. Values come from `scripts/upload-sagemaker-artifacts.sh`
    // via `scripts/deploy.sh` context. Fallback strings only matter on
    // the very first ever deploy, before the upload script has run.
    // Parakeet uses the NVIDIA-tested older DLC (2.5.1-py311). NeMo's
    // dep graph resolves cleanly there; on the shared 2.6.0-py312 image
    // torchaudio / torchvision version pins conflict during
    // `pip install nemo_toolkit[asr]` at container startup. Pinning the
    // image per-model keeps the other two endpoints on the newer DLC.
    const parakeetImageUri =
      `763104351884.dkr.ecr.${this.region}.amazonaws.com/` +
      `pytorch-inference:2.5.1-gpu-py311-cu124-ubuntu22.04-sagemaker`;

    const sagemakerEndpoints = new SageMakerByocEndpoints(this, 'SageMakerByocEndpoints', {
      models: [
        {
          name: 'WhisperLargeV3',
          modelDataUrl: `s3://${props.deploymentConfig.sagemakerModelBucket}/whisper-large-v3/model.tar.gz`,
          instanceType: 'ml.g6.xlarge',
          // Distil-Whisper on the L4 GPU comfortably finishes multi-minute
          // audio within SageMaker's 60 s sync invoke cap, but we keep
          // TorchServe's response timeout above the SageMaker cap for
          // defense-in-depth (default is 120 s; the Lambda invoker
          // timeout in `infra/lib/ai/sagemaker-worker.ts` is 900 s).
          environment: {
            SAGEMAKER_MODEL_SERVER_TIMEOUT: '600',
            MODEL_TARBALL_ETAG: props.deploymentConfig.whisperModelEtag ?? 'unset',
          },
        },
        {
          name: 'QwenAsrV1',
          modelDataUrl: `s3://${props.deploymentConfig.sagemakerModelBucket}/qwen-asr/model.tar.gz`,
          instanceType: 'ml.g6.xlarge',
          environment: {
            MODEL_TARBALL_ETAG: props.deploymentConfig.qwenModelEtag ?? 'unset',
          },
        },
        {
          name: 'ParakeetTdt06B',
          modelDataUrl: `s3://${props.deploymentConfig.sagemakerModelBucket}/nvidia-parakeet/model.tar.gz`,
          instanceType: 'ml.g6.xlarge',
          imageUri: parakeetImageUri,
          // NeMo installs `nemo_toolkit[asr]` at container startup, which
          // resolves ~4 GB of transitive deps and can take 5-8 min the
          // first time. Give it headroom before the SageMaker healthcheck
          // kills the container.
          startupTimeout: 1200,
          environment: {
            SAGEMAKER_MODEL_SERVER_TIMEOUT: '600',
            MODEL_LOADING_TIMEOUT: '600',
            MODEL_TARBALL_ETAG: props.deploymentConfig.parakeetModelEtag ?? 'unset',
          },
        },
      ],
    });

    // Map catalog modelIds → SageMaker endpoint names. The worker handler
    // reads this via SAGEMAKER_ENDPOINT_MAP and uses modelId to pick the
    // right endpoint at invocation time.
    const sagemakerWorker = new SageMakerWorker(this, 'SageMakerWorker', {
      table: jobTable.table,
      bucket: audioBucket.bucket,
      endpointNames: {
        'sagemaker-whisper-large-v3': sagemakerEndpoints.endpointNames.WhisperLargeV3,
        'sagemaker-qwen-asr': sagemakerEndpoints.endpointNames.QwenAsrV1,
        'sagemaker-parakeet-tdt-0.6b': sagemakerEndpoints.endpointNames.ParakeetTdt06B,
      },
    });

    // --- Compute ---
    const uploadHandler = new UploadHandler(this, 'UploadHandler', {
      bucket: audioBucket.bucket,
    });

    const orchestrator = new Orchestrator(this, 'Orchestrator', {
      table: jobTable.table,
      bucket: audioBucket.bucket,
      workerFunctions: {
        bedrock: bedrockWorker.handler,
        sagemaker: sagemakerWorker.handler,
        transcribe: transcribeWorker.handler,
      },
    });

    const jobsHandler = new JobsHandler(this, 'JobsHandler', {
      table: jobTable.table,
      bucket: audioBucket.bucket,
    });

    // --- Catalog Handler (inline Lambda returning model catalog) ---
    const catalogLogGroup = new LogGroup(this, 'CatalogHandlerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });
    // Custom execution role — avoids `AWSLambdaBasicExecutionRole` (AwsSolutions-IAM4).
    const catalogRole = createScopedLambdaRole(this, 'CatalogHandlerExecutionRole', catalogLogGroup);

    const catalogHandler = new NodejsFunction(this, 'CatalogHandlerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/api/catalog-handler.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      logGroup: catalogLogGroup,
      role: catalogRole,
      bundling: {
        forceDockerBundling: false,
      },
    });

    // --- Samples Handler (lists pre-available audio files from S3) ---
    const samplesLogGroup = new LogGroup(this, 'SamplesHandlerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });
    const samplesRole = createScopedLambdaRole(this, 'SamplesHandlerExecutionRole', samplesLogGroup);

    const samplesHandler = new NodejsFunction(this, 'SamplesHandlerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/api/samples-handler.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: {
        BUCKET_NAME: audioBucket.bucket.bucketName,
      },
      logGroup: samplesLogGroup,
      role: samplesRole,
      bundling: {
        forceDockerBundling: false,
      },
    });
    audioBucket.bucket.grantRead(samplesHandler);

    // --- WebSocket connect/disconnect handlers ---
    const connectLogGroup = new LogGroup(this, 'ConnectHandlerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });
    const connectRole = createScopedLambdaRole(this, 'ConnectHandlerExecutionRole', connectLogGroup);

    const connectHandler = new NodejsFunction(this, 'ConnectHandlerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/api/websocket-connect.ts',
      handler: 'handler',
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: jobTable.table.tableName,
      },
      logGroup: connectLogGroup,
      role: connectRole,
      bundling: { forceDockerBundling: false },
    });
    jobTable.table.grantWriteData(connectHandler);

    const disconnectLogGroup = new LogGroup(this, 'DisconnectHandlerLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });
    const disconnectRole = createScopedLambdaRole(
      this,
      'DisconnectHandlerExecutionRole',
      disconnectLogGroup,
    );

    const disconnectHandler = new NodejsFunction(this, 'DisconnectHandlerFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/api/websocket-disconnect.ts',
      handler: 'handler',
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: jobTable.table.tableName,
      },
      logGroup: disconnectLogGroup,
      role: disconnectRole,
      bundling: { forceDockerBundling: false },
    });
    jobTable.table.grantReadWriteData(disconnectHandler);

    // --- WebSocket API (needs connect/disconnect handlers) ---
    const webSocketApi = new WebSocketApi(this, 'WebSocketApi', {
      connectHandler,
      disconnectHandler,
    });

    // --- WebSocket Push (needs the WebSocket API callback URL) ---
    const webSocketPush = new WebSocketPush(this, 'WebSocketPush', {
      table: jobTable.table,
      webSocketEndpoint: webSocketApi.callbackUrl,
      webSocketApiId: webSocketApi.api.ref,
    });

    // --- Evaluator (computes WER/MER/Semantic WER/LLM-as-Judge from DDB stream) ---
    const evaluator = new Evaluator(this, 'Evaluator', {
      table: jobTable.table,
      bucket: audioBucket.bucket,
    });

    // --- REST API ---
    const restApi = new RestApiGateway(this, 'RestApi', {
      userPool: auth.userPool,
      uploadHandler: uploadHandler.handler,
      orchestratorHandler: orchestrator.handler,
      jobsHandler: jobsHandler.handler,
      catalogHandler,
      samplesHandler,
    });

    // --- Observability ---
    const monitoring = new Monitoring(this, 'Monitoring', {
      workers: [
        { name: 'BedrockWorker', fn: bedrockWorker.handler },
        { name: 'SageMakerWorker', fn: sagemakerWorker.handler },
        { name: 'TranscribeWorker', fn: transcribeWorker.handler },
        { name: 'Evaluator', fn: evaluator.handler },
      ],
    });

    // --- Outputs ---
    new CfnOutput(this, 'TestUserEmail', {
      value: testUser.email,
      description: 'Sign-in email for the deploy-time test user.',
    });

    new CfnOutput(this, 'TestUserPassword', {
      value: testUser.password,
      description:
        'Test user password — for development and testing only. Do not use in production.',
    });

    new CfnOutput(this, 'RestApiUrl', {
      value: restApi.api.url,
      description: 'REST API endpoint URL',
    });

    new CfnOutput(this, 'WebSocketUrl', {
      value: webSocketApi.webSocketUrl,
      description: 'WebSocket endpoint URL for client connections',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: auth.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: auth.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new CfnOutput(this, 'IdentityPoolId', {
      value: auth.identityPoolId,
      description: 'Cognito Identity Pool ID',
    });

    new CfnOutput(this, 'AudioBucketName', {
      value: audioBucket.bucket.bucketName,
      description: 'S3 bucket for audio file storage',
    });

    new CfnOutput(this, 'JobTableName', {
      value: jobTable.table.tableName,
      description: 'DynamoDB table for job metadata',
    });

    new CfnOutput(this, 'AwsRegion', {
      value: this.region,
      description: 'AWS region the stack is deployed into',
    });
  }
}
