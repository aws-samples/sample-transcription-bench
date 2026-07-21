import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';
import { isValidModelSelection, MIN_MODEL_COUNT, MAX_MODEL_COUNT } from '../shared/validation';
import { MODEL_CATALOG } from '../shared/model-catalog';
import {
  writeJobRecord,
  writeModelResult,
  buildJobPK,
  buildJobSK,
  buildResultPK,
  buildResultSK,
} from '../shared/dynamodb';
import { JobRecord, ModelResultRecord, WorkerEvent } from '../shared/types';
import { logger } from '../shared/logger';

const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

/**
 * Provider-keyed map of worker Lambda ARNs, populated by CDK as a JSON object
 * (e.g. `{"bedrock":"arn:...","sagemaker":"arn:...","transcribe":"arn:..."}`).
 *
 * Using a name-keyed map (instead of an array + index) prevents silent
 * mis-routing if the CDK construct order changes, and makes it obvious when a
 * provider has no worker wired up (the lookup returns `undefined` and we fail
 * fast for that model only — see `dispatchModel` below).
 */
const WORKER_FUNCTION_ARNS: Record<string, string> = JSON.parse(
  process.env.WORKER_FUNCTION_ARNS || '{}',
);

interface CreateJobRequest {
  s3Key: string;
  modelIds: string[];
  groundTruthS3Key?: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return errorResponse(401, 'Unauthorized', 'Valid authentication token required');
    }

    if (!event.body) {
      return errorResponse(400, 'BadRequest', 'Request body is required');
    }

    let request: CreateJobRequest;
    try {
      request = JSON.parse(event.body);
    } catch {
      return errorResponse(400, 'BadRequest', 'Invalid JSON in request body');
    }

    if (!request.s3Key || !request.modelIds) {
      return errorResponse(400, 'BadRequest', 's3Key and modelIds are required');
    }

    // Validate modelIds — 2 to 5, all in catalog
    if (!Array.isArray(request.modelIds) || request.modelIds.length < MIN_MODEL_COUNT || request.modelIds.length > MAX_MODEL_COUNT) {
      return errorResponse(400, 'BadRequest', `Between ${MIN_MODEL_COUNT} and ${MAX_MODEL_COUNT} model IDs are required`);
    }

    if (!isValidModelSelection(request.modelIds)) {
      // Determine which model ID is invalid
      const catalogIds = new Set(MODEL_CATALOG.map((m) => m.modelId));
      const invalidId = request.modelIds.find((id) => !catalogIds.has(id));
      return errorResponse(400, 'BadRequest', `Model ID '${invalidId}' not found in catalog`);
    }

    // Verify S3 key exists
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: BUCKET_NAME,
          Key: request.s3Key,
        }),
      );
    } catch (err: unknown) {
      const errorName = (err as { name?: string })?.name;
      if (errorName === 'NotFound' || errorName === 'NoSuchKey' || errorName === '404') {
        return errorResponse(404, 'NotFound', 'Audio file not found');
      }
      throw err;
    }

    // Generate job ID and timestamps
    const jobId = uuidv4();
    const now = new Date().toISOString();

    // If ground truth key provided, verify it exists
    if (request.groundTruthS3Key) {
      try {
        await s3Client.send(
          new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: request.groundTruthS3Key,
          }),
        );
      } catch (err: unknown) {
        const errorName = (err as { name?: string })?.name;
        if (errorName === 'NotFound' || errorName === 'NoSuchKey' || errorName === '404') {
          return errorResponse(404, 'NotFound', 'Ground truth file not found');
        }
        throw err;
      }
    }

    // Create job record in DynamoDB with PENDING status
    const jobRecord: JobRecord = {
      PK: buildJobPK(userId),
      SK: buildJobSK(jobId),
      GSI1PK: `JOB#${jobId}`,
      GSI1SK: 'META',
      jobId,
      userId,
      status: 'PENDING',
      s3Key: request.s3Key,
      s3Bucket: BUCKET_NAME,
      modelIds: request.modelIds,
      ...(request.groundTruthS3Key && { groundTruthS3Key: request.groundTruthS3Key }),
      createdAt: now,
      startedAt: now,
    };

    await writeJobRecord(jobRecord);

    // Fan out to per-provider worker Lambdas. Each invoke is independent —
    // if one fails (or has no worker mapped), we record a per-model failure
    // and let the rest of the comparison proceed. Pre-2-5 selection this
    // failed the entire job because Promise.all rejects on the first throw.
    const dispatchResults = await Promise.allSettled(
      request.modelIds.map((modelId) => dispatchModel(jobId, modelId, request.s3Key, now)),
    );

    const dispatchFailures = dispatchResults.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (dispatchFailures.length > 0) {
      logger.warn({
        event: 'orchestrator_partial_dispatch',
        jobId,
        totalModels: request.modelIds.length,
        failed: dispatchFailures.length,
        reasons: dispatchFailures.map((f) => String(f.reason)),
      });
    }

    // Log job creation
    logger.info({
      event: 'job_created',
      jobId,
      userId,
      modelIds: request.modelIds,
      s3Key: request.s3Key,
    });

    return {
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      },
      body: JSON.stringify({
        jobId,
        status: 'PENDING',
        createdAt: now,
      }),
    };
  } catch (error) {
    logger.error({
      event: 'orchestrator_error',
      error: error instanceof Error ? error.message : String(error),
      errorName: (error as any)?.name,
      errorStack: (error as any)?.stack,
    });

    return errorResponse(500, 'InternalError', 'An unexpected error occurred');
  }
};

/**
 * Resolve the worker Lambda for a given model and asynchronously invoke it.
 *
 * Failure modes are handled per-model so a single misconfigured provider
 * doesn't break the rest of the comparison:
 *   - Provider has no Lambda mapped (e.g. SageMaker not deployed in this env)
 *     → write an ENDPOINT_NOT_FOUND result row and return.
 *   - InvokeCommand throws (transient SDK failure, throttling, etc.)
 *     → write an UNKNOWN result row and rethrow so the caller can log it.
 *
 * Both paths give the UI a visible failure for that specific model rather
 * than collapsing the whole job into a 500.
 */
async function dispatchModel(
  jobId: string,
  modelId: string,
  s3Key: string,
  now: string,
): Promise<void> {
  const model = MODEL_CATALOG.find((m) => m.modelId === modelId)!;
  const functionArn = WORKER_FUNCTION_ARNS[model.provider];

  if (!functionArn) {
    logger.error({
      event: 'orchestrator_no_worker_for_provider',
      jobId,
      modelId,
      provider: model.provider,
      configuredProviders: Object.keys(WORKER_FUNCTION_ARNS),
    });

    const errorRecord: ModelResultRecord = {
      PK: buildResultPK(jobId),
      SK: buildResultSK(modelId),
      jobId,
      modelId,
      status: 'ERROR',
      errorCode: 'ENDPOINT_NOT_FOUND',
      errorMessage: `${model.modelName} isn't deployed in this environment.`,
      errorDetails: `No worker Lambda is configured for provider '${model.provider}'.`,
      completedAt: now,
    };
    await writeModelResult(errorRecord);
    return;
  }

  const workerEvent: WorkerEvent = {
    jobId,
    modelId,
    s3Key,
    s3Bucket: BUCKET_NAME,
  };

  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: InvocationType.Event,
        Payload: Buffer.from(JSON.stringify(workerEvent)),
      }),
    );
  } catch (invokeError) {
    const message =
      invokeError instanceof Error ? invokeError.message : String(invokeError);
    const errorRecord: ModelResultRecord = {
      PK: buildResultPK(jobId),
      SK: buildResultSK(modelId),
      jobId,
      modelId,
      status: 'ERROR',
      errorCode: 'UNKNOWN',
      errorMessage: `${model.modelName} could not be dispatched.`,
      errorDetails: message,
      completedAt: now,
    };
    // Best-effort: if the result write also fails the orchestrator catch
    // block will still log the original invoke failure.
    await writeModelResult(errorRecord);
    throw invokeError;
  }
}

function errorResponse(statusCode: number, error: string, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify({ error, message }),
  };
}
