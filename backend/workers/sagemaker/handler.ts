import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  SageMakerRuntimeClient,
  InvokeEndpointCommand,
} from '@aws-sdk/client-sagemaker-runtime';
import { WorkerEvent, ModelResultRecord } from '../../shared/types';
import {
  writeModelResult,
  buildResultPK,
  buildResultSK,
} from '../../shared/dynamodb';
import { MODEL_CATALOG } from '../../shared/model-catalog';
import { logger } from '../../shared/logger';
import { mapWorkerError } from '../../shared/errors';

const s3Client = new S3Client({});
const sagemakerClient = new SageMakerRuntimeClient({});

/**
 * Map of catalog modelId -> SageMaker endpoint name.
 * Populated from the SAGEMAKER_ENDPOINT_MAP env var set by CDK.
 */
const ENDPOINT_MAP: Record<string, string> = JSON.parse(
  process.env.SAGEMAKER_ENDPOINT_MAP ?? '{}',
);

/**
 * Invoke a BYOC SageMaker ASR endpoint (Whisper or Qwen). Both endpoints
 * share the same inference protocol:
 *   - Request : application/json {"url": "<presigned S3 URL>"}
 *   - Response: application/json {"language": "<...>", "text": "<...>"}
 * Using a presigned URL avoids the ~6 MB SageMaker InvokeEndpoint sync
 * payload limit for larger WAV files; the inference handler downloads
 * the audio server-side.
 */
async function invokeByocAsr(
  endpointName: string,
  s3Bucket: string,
  s3Key: string,
): Promise<string> {
  const presignedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
    { expiresIn: 300 },
  );

  const payload = JSON.stringify({ url: presignedUrl });

  const smResponse = await sagemakerClient.send(
    new InvokeEndpointCommand({
      EndpointName: endpointName,
      ContentType: 'application/json',
      Accept: 'application/json',
      Body: new TextEncoder().encode(payload),
    }),
  );

  const responseBody = JSON.parse(
    new TextDecoder().decode(smResponse.Body as Uint8Array),
  );

  return responseBody.text ?? '';
}

/**
 * Route to the correct invocation function based on modelId.
 *
 * Whisper and Qwen are both BYOC endpoints that speak the same JSON
 * protocol, so they share a single invoker. Kept as a separate function
 * for forward-compat with other SageMaker models that might join the
 * catalog with a different request shape.
 */
async function invokeModel(
  modelId: string,
  endpointName: string,
  s3Bucket: string,
  s3Key: string,
): Promise<string> {
  if (
    modelId === 'sagemaker-qwen-asr' ||
    modelId === 'sagemaker-whisper-large-v3' ||
    modelId === 'sagemaker-parakeet-tdt-0.6b'
  ) {
    return invokeByocAsr(endpointName, s3Bucket, s3Key);
  }
  // Default: treat as BYOC ASR — same protocol.
  return invokeByocAsr(endpointName, s3Bucket, s3Key);
}

function estimateAudioDurationMinutes(fileSizeBytes: number): number {
  const bytesPerMinute = 1.5 * 1024 * 1024;
  return fileSizeBytes / bytesPerMinute;
}

export const handler = async (event: WorkerEvent): Promise<void> => {
  const startTime = Date.now();
  const { jobId, modelId, s3Key, s3Bucket } = event;

  logger.info({ event: 'worker_started', jobId, modelId, s3Key });

  try {
    const headResponse = await s3Client.send(
      new HeadObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
    );
    const contentLength = headResponse.ContentLength ?? 0;

    const endpointName = ENDPOINT_MAP[modelId];
    if (!endpointName) {
      throw new Error(`No SageMaker endpoint mapping found for modelId: ${modelId}`);
    }

    const transcriptionText = await invokeModel(modelId, endpointName, s3Bucket, s3Key);

    const latencyMs = Date.now() - startTime;
    const catalogEntry = MODEL_CATALOG.find((m) => m.modelId === modelId);
    const costPerMinute = catalogEntry?.costPerMinute ?? 0;
    const durationMinutes = estimateAudioDurationMinutes(contentLength);
    const estimatedCostUsd = parseFloat(
      (costPerMinute * durationMinutes).toFixed(6),
    );

    const result: ModelResultRecord = {
      PK: buildResultPK(jobId),
      SK: buildResultSK(modelId),
      jobId,
      modelId,
      status: 'COMPLETED',
      transcriptionText,
      latencyMs,
      estimatedCostUsd,
      completedAt: new Date().toISOString(),
    };

    await writeModelResult(result);
    logger.info({ event: 'worker_completed', jobId, modelId, latencyMs, estimatedCostUsd });
  } catch (error) {
    const catalogEntry = MODEL_CATALOG.find((m) => m.modelId === modelId);
    const mapped = mapWorkerError(error, {
      modelId,
      modelName: catalogEntry?.modelName,
      provider: 'sagemaker',
    });

    const errorResult: ModelResultRecord = {
      PK: buildResultPK(jobId),
      SK: buildResultSK(modelId),
      jobId,
      modelId,
      status: mapped.status,
      errorMessage: mapped.userMessage,
      errorCode: mapped.code,
      errorDetails: mapped.rawMessage,
      completedAt: new Date().toISOString(),
    };

    try {
      await writeModelResult(errorResult);
    } catch (writeErr) {
      logger.error({
        event: 'worker_dynamo_write_error',
        jobId,
        modelId,
        error: writeErr instanceof Error ? writeErr.message : 'Unknown',
      });
    }

    logger.error({
      event: 'worker_error',
      jobId,
      modelId,
      errorCode: mapped.code,
      error: mapped.rawMessage,
      userMessage: mapped.userMessage,
    });
  }
};
