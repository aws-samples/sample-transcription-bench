import { Aws, CfnOutput } from 'aws-cdk-lib';
import {
  CfnModel,
  CfnEndpointConfig,
  CfnEndpoint,
} from 'aws-cdk-lib/aws-sagemaker';
import {
  Role,
  ServicePrincipal,
  ManagedPolicy,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Configuration for a BYOC (Bring Your Own Container) SageMaker model.
 * Uses the AWS PyTorch Inference DLC with custom inference code bundled
 * inside the model.tar.gz under a code/ directory.
 */
export interface ByocModelConfig {
  /** Logical name used in resource IDs (e.g. 'ParakeetTDT') */
  name: string;
  /**
   * S3 URI to the model.tar.gz.
   * Must contain model weights at the root AND a code/ directory with
   * inference.py and requirements.txt.
   */
  modelDataUrl: string;
  /** SageMaker instance type (e.g. 'ml.g6.xlarge') */
  instanceType: string;
  /** Number of instances (default 1) */
  instanceCount?: number;
  /** Container startup health check timeout in seconds (default 900) */
  startupTimeout?: number;
  /** Model download timeout in seconds (default 600) */
  modelDownloadTimeout?: number;
  /** Extra environment variables for the container */
  environment?: Record<string, string>;
  /**
   * Optional per-model DLC image URI override. When omitted, all models
   * share the construct-level default (see `imageUri` below). Useful for
   * models like NeMo/Parakeet that need a specific PyTorch/Python
   * combination that the shared DLC image doesn't provide.
   */
  imageUri?: string;
}

export interface SageMakerByocEndpointsProps {
  models: ByocModelConfig[];
}

/**
 * Deploys custom ASR models as SageMaker real-time inference endpoints
 * using the AWS PyTorch Inference DLC with custom inference scripts.
 *
 * The model.tar.gz must contain:
 *   - Model weights at the root (e.g. .nemo file or HF model files)
 *   - code/ directory with inference.py and requirements.txt
 *
 * The PyTorch serving container auto-discovers code/inference.py and
 * installs code/requirements.txt at startup.
 */
export class SageMakerByocEndpoints extends Construct {
  /** Map of model logical name -> endpoint name */
  public readonly endpointNames: Record<string, string>;

  constructor(scope: Construct, id: string, props: SageMakerByocEndpointsProps) {
    super(scope, id);

    this.endpointNames = {};

    // Shared execution role
    const executionRole = new Role(this, 'ByocExecutionRole', {
      assumedBy: new ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
      ],
    });

    // Grant S3 read for model data and ECR pull for the DLC image
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:ListBucket',
        ],
        resources: ['*'],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      }),
    );

    // PyTorch Inference DLC — default image, used by any model that
    // doesn't override `imageUri` in its config.
    const dlcAccount = '763104351884';
    const defaultImageTag = '2.6.0-gpu-py312-cu124-ubuntu22.04-sagemaker';
    const defaultImageUri = `${dlcAccount}.dkr.ecr.${Aws.REGION}.amazonaws.com/pytorch-inference:${defaultImageTag}`;

    for (const cfg of props.models) {
      const {
        name,
        modelDataUrl,
        instanceType,
        instanceCount = 1,
        startupTimeout = 900,
        modelDownloadTimeout = 600,
        environment = {},
        imageUri,
      } = cfg;

      const model = new CfnModel(this, `${name}Model`, {
        executionRoleArn: executionRole.roleArn,
        primaryContainer: {
          image: imageUri ?? defaultImageUri,
          modelDataUrl,
          environment: {
            SAGEMAKER_CONTAINER_LOG_LEVEL: '20',
            SAGEMAKER_REGION: Aws.REGION,
            SAGEMAKER_PROGRAM: 'inference.py',
            ...environment,
          },
        },
      });

      const endpointConfig = new CfnEndpointConfig(this, `${name}EndpointConfig`, {
        productionVariants: [
          {
            variantName: 'AllTraffic',
            modelName: model.attrModelName,
            initialInstanceCount: instanceCount,
            instanceType,
            initialVariantWeight: 1,
            containerStartupHealthCheckTimeoutInSeconds: startupTimeout,
            modelDataDownloadTimeoutInSeconds: modelDownloadTimeout,
          },
        ],
      });
      endpointConfig.addDependency(model);

      const endpoint = new CfnEndpoint(this, `${name}Endpoint`, {
        endpointConfigName: endpointConfig.attrEndpointConfigName,
      });
      endpoint.addDependency(endpointConfig);

      this.endpointNames[name] = endpoint.attrEndpointName;

      new CfnOutput(this, `${name}EndpointName`, {
        value: endpoint.attrEndpointName,
        description: `SageMaker BYOC endpoint for ${name}`,
      });
    }
  }
}
