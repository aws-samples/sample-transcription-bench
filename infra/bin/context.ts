import { App } from 'aws-cdk-lib';

/**
 * Resolved deployment configuration for the CDK app.
 *
 * Account and region are read from the standard `CDK_DEFAULT_*` environment
 * variables. Everything else is sourced from CDK context (`cdk.json`,
 * `-c key=value`, or `~/.cdk.json`) with documented defaults and format
 * validation applied here, before the stack is constructed.
 */
export interface DeploymentConfig {
  /** AWS account from `CDK_DEFAULT_ACCOUNT`. */
  account: string;
  /** AWS region from `CDK_DEFAULT_REGION`. */
  region: string;
  /** CloudFormation stack name. Defaults to `AudioTranscriptionStack`. */
  stackName: string;
  /** Optional explicit Cognito User Pool name. */
  userPoolName?: string;
  /**
   * S3 bucket holding SageMaker BYOC model artifacts. Defaults to
   * `sagemaker-${region}-${account}` when not supplied.
   */
  sagemakerModelBucket: string;
  /**
   * S3 ETag of the Distil-Whisper `model.tar.gz` at deploy time.
   * Baked into the SageMaker container env so tarball changes force a
   * CFN Model replacement (and endpoint blue/green roll). Populated by
   * `scripts/deploy.sh` from `.sagemaker-model-etags`; may be undefined
   * on the very first deploy before the upload script runs.
   */
  whisperModelEtag?: string;
  /** S3 ETag of the Qwen ASR `model.tar.gz`. Same purpose as above. */
  qwenModelEtag?: string;
  /** S3 ETag of the NVIDIA Parakeet TDT `model.tar.gz`. */
  parakeetModelEtag?: string;
}

const STACK_NAME_REGEX = /^[A-Za-z0-9-]{1,128}$/;
const USER_POOL_NAME_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
// S3 bucket naming: 3-63 chars, must start and end with a lowercase letter or digit.
const S3_BUCKET_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// Bucket names cannot be formatted like an IPv4 address.
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

const DEFAULT_STACK_NAME = 'AudioTranscriptionStack';

/**
 * A context value supplied as `undefined`, a non-string, or a string whose
 * `String(v).trim()` is empty is treated as "not supplied".
 */
function trimmedContext(app: App, key: string): string | undefined {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const trimmed = String(raw).trim();
  return trimmed === '' ? undefined : trimmed;
}

function requireEnv(name: string, message: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(message);
  }
  return raw;
}

/**
 * Resolve and validate every deployment-time configuration value before
 * the stack is instantiated. Throws `Error` with a message identifying the
 * offending env var or context key on any rule violation.
 */
export function loadDeploymentConfig(app: App): DeploymentConfig {
  const account = requireEnv(
    'CDK_DEFAULT_ACCOUNT',
    'Missing CDK_DEFAULT_ACCOUNT environment variable; cannot determine target AWS account.',
  );
  const region = requireEnv(
    'CDK_DEFAULT_REGION',
    'Missing CDK_DEFAULT_REGION environment variable; cannot determine target AWS region.',
  );

  const stackNameCtx = trimmedContext(app, 'stack_name');
  const stackName = stackNameCtx ?? DEFAULT_STACK_NAME;
  if (stackNameCtx !== undefined && !STACK_NAME_REGEX.test(stackNameCtx)) {
    throw new Error(
      'Invalid context value for "stack_name": must be 1-128 characters of letters, digits, and hyphens.',
    );
  }

  const userPoolNameCtx = trimmedContext(app, 'user_pool_name');
  if (userPoolNameCtx !== undefined && !USER_POOL_NAME_REGEX.test(userPoolNameCtx)) {
    throw new Error(
      'Invalid context value for "user_pool_name": must be 1-128 characters of letters, digits, hyphens, and underscores.',
    );
  }

  const bucketCtx = trimmedContext(app, 'sagemaker_model_bucket');
  let sagemakerModelBucket: string;
  if (bucketCtx !== undefined) {
    if (
      bucketCtx.length < 3 ||
      bucketCtx.length > 63 ||
      !S3_BUCKET_REGEX.test(bucketCtx) ||
      bucketCtx.includes('..') ||
      IPV4_REGEX.test(bucketCtx)
    ) {
      throw new Error(
        'Invalid context value for "sagemaker_model_bucket": must be 3-63 lowercase chars matching S3 bucket naming rules.',
      );
    }
    sagemakerModelBucket = bucketCtx;
  } else {
    sagemakerModelBucket = `sagemaker-${region}-${account}`;
  }

  // ETag context keys are opaque hex strings from `aws s3api head-object`
  // (possibly with hyphens for multipart uploads). We accept any non-empty
  // trimmed string; the format is not part of any AWS API contract we care
  // about here — CDK just needs the value to differ when the tarball
  // content differs.
  const whisperModelEtag = trimmedContext(app, 'whisper_model_etag');
  const qwenModelEtag = trimmedContext(app, 'qwen_model_etag');
  const parakeetModelEtag = trimmedContext(app, 'parakeet_model_etag');

  return {
    account,
    region,
    stackName,
    userPoolName: userPoolNameCtx,
    sagemakerModelBucket,
    whisperModelEtag,
    qwenModelEtag,
    parakeetModelEtag,
  };
}
