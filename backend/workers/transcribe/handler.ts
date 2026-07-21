import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  TranscriptionJobStatus,
  MediaFormat,
} from '@aws-sdk/client-transcribe';
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
const transcribeClient = new TranscribeClient({});

const BUCKET_NAME = process.env.BUCKET_NAME ?? '';

/** Max total polling time in ms (~240s to stay within 300s Lambda timeout). */
const MAX_POLL_TIME_MS = 240_000;
/** Initial polling delay in ms. */
const INITIAL_DELAY_MS = 2_000;
/** Maximum delay between polls in ms. */
const MAX_DELAY_MS = 30_000;

/**
 * Estimate audio duration in minutes from file size.
 * Rough heuristic: ~1.5 MB per minute for cost approximation.
 */
function estimateAudioDurationMinutes(fileSizeBytes: number): number {
  const bytesPerMinute = 1.5 * 1024 * 1024;
  return fileSizeBytes / bytesPerMinute;
}

/**
 * Derive AWS Transcribe MediaFormat from the S3 key extension.
 */
function deriveMediaFormat(s3Key: string): MediaFormat {
  const ext = s3Key.split('.').pop()?.toLowerCase() ?? '';
  const formatMap: Record<string, MediaFormat> = {
    wav: 'wav',
    mp3: 'mp3',
    flac: 'flac',
    ogg: 'ogg',
    m4a: 'mp4',
    mp4: 'mp4',
  };
  return formatMap[ext] ?? 'wav';
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the transcript result JSON from S3.
 * When OutputBucketName is set, Transcribe writes the result as
 * {TranscriptionJobName}.json in the output bucket.
 */
async function fetchTranscriptFromS3(
  bucket: string,
  transcriptionJobName: string,
): Promise<string> {
  const key = `${transcriptionJobName}.json`;
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return await response.Body!.transformToString('utf-8');
}

export const handler = async (event: WorkerEvent): Promise<void> => {
  const startTime = Date.now();
  const { jobId, modelId, s3Key, s3Bucket } = event;

  logger.info({
    event: 'worker_started',
    jobId,
    modelId,
    s3Key,
  });

  try {
    // 1. Get audio file size from S3 for cost estimation
    const s3Response = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
    );
    const contentLength = s3Response.ContentLength ?? 0;

    // 2. Start AWS Transcribe job pointing to S3 URI
    const transcriptionJobName = `${jobId}-${modelId}`;
    const s3Uri = `s3://${s3Bucket}/${s3Key}`;
    const mediaFormat = deriveMediaFormat(s3Key);

    await transcribeClient.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: transcriptionJobName,
        LanguageCode: 'en-US',
        Media: { MediaFileUri: s3Uri },
        MediaFormat: mediaFormat,
        OutputBucketName: BUCKET_NAME || undefined,
      }),
    );

    // 3. Poll GetTranscriptionJob with exponential backoff
    let delay = INITIAL_DELAY_MS;
    let totalWaited = 0;
    let jobStatus: TranscriptionJobStatus | undefined;
    let transcriptFileUri: string | undefined;
    let failureReason: string | undefined;

    while (totalWaited < MAX_POLL_TIME_MS) {
      await sleep(delay);
      totalWaited += delay;

      const pollResponse = await transcribeClient.send(
        new GetTranscriptionJobCommand({
          TranscriptionJobName: transcriptionJobName,
        }),
      );

      jobStatus = pollResponse.TranscriptionJob?.TranscriptionJobStatus;
      transcriptFileUri =
        pollResponse.TranscriptionJob?.Transcript?.TranscriptFileUri;
      failureReason = pollResponse.TranscriptionJob?.FailureReason;

      if (
        jobStatus === TranscriptionJobStatus.COMPLETED ||
        jobStatus === TranscriptionJobStatus.FAILED
      ) {
        break;
      }

      // Exponential backoff: double delay, cap at MAX_DELAY_MS
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }

    // 4. Handle transcription job result. The thrown messages are inspected
    // by mapWorkerError so they need to contain words it recognises (
    // "timed out" -> MODEL_TIMEOUT, "invalid"/"unsupported" -> INVALID_AUDIO).
    if (jobStatus === TranscriptionJobStatus.FAILED) {
      const reason = failureReason ?? 'Unknown reason';
      // AWS Transcribe failure reasons frequently include "Invalid file format"
      // or quota strings — pass them through verbatim so the mapper can
      // categorise correctly.
      const err = new Error(`Transcribe job failed: ${reason}`);
      (err as { name?: string }).name = 'TranscribeJobFailed';
      throw err;
    }

    if (jobStatus !== TranscriptionJobStatus.COMPLETED) {
      const err = new Error(
        `Transcribe job timed out after ${totalWaited}ms (status: ${jobStatus ?? 'UNKNOWN'})`,
      );
      (err as { name?: string }).name = 'TimeoutError';
      throw err;
    }

    // 5. Fetch result JSON from S3 and extract transcription text
    const resultJson = await fetchTranscriptFromS3(BUCKET_NAME, transcriptionJobName);
    const resultData = JSON.parse(resultJson);
    const transcriptionText: string =
      resultData.results?.transcripts?.[0]?.transcript ?? '';

    // 6. Calculate latency and cost
    const latencyMs = Date.now() - startTime;
    const catalogEntry = MODEL_CATALOG.find((m) => m.modelId === modelId);
    const costPerMinute = catalogEntry?.costPerMinute ?? 0;
    const durationMinutes = estimateAudioDurationMinutes(contentLength);
    const estimatedCostUsd = parseFloat(
      (costPerMinute * durationMinutes).toFixed(6),
    );

    // 7. Write success result to DynamoDB
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

    logger.info({
      event: 'worker_completed',
      jobId,
      modelId,
      latencyMs,
      estimatedCostUsd,
    });
  } catch (error) {
    // On error: classify, then write a friendly row to DynamoDB.
    const catalogEntry = MODEL_CATALOG.find((m) => m.modelId === modelId);
    const mapped = mapWorkerError(error, {
      modelId,
      modelName: catalogEntry?.modelName,
      provider: 'transcribe',
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
