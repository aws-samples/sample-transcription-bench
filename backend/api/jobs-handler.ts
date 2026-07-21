import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { queryJobsByUser, getJobById, getModelResults, getEvaluations, deleteJobAndResults } from '../shared/dynamodb';
import { EvaluationRecord, JobRecord, ModelResultRecord } from '../shared/types';

const s3Client = new S3Client({});
const AUDIO_BUCKET = process.env.AUDIO_BUCKET_NAME ?? '';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,DELETE,OPTIONS',
};

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return errorResponse(401, 'Unauthorized', 'Valid authentication token required');
    }

    const jobId = event.pathParameters?.jobId;

    if (jobId && event.httpMethod === 'DELETE') {
      return handleDeleteJob(userId, jobId);
    }

    if (jobId) {
      return handleGetJobDetail(userId, jobId);
    }

    return handleListJobs(userId, event);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'JOBS_HANDLER_ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));

    return errorResponse(500, 'InternalError', 'An unexpected error occurred');
  }
};

async function handleListJobs(
  userId: string,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cursor = event.queryStringParameters?.cursor;
  const rawLimit = event.queryStringParameters?.limit;
  let limit = DEFAULT_PAGE_LIMIT;

  if (rawLimit) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_PAGE_LIMIT);
    }
  }

  const { items, nextCursor } = await queryJobsByUser(userId, limit, cursor);

  const jobs = items.map(toJobSummary);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ jobs, ...(nextCursor && { nextCursor }) }),
  };
}

async function handleGetJobDetail(
  userId: string,
  jobId: string,
): Promise<APIGatewayProxyResult> {
  const job = await getJobById(jobId);

  if (!job) {
    return errorResponse(404, 'NotFound', 'Job not found');
  }

  if (job.userId !== userId) {
    return errorResponse(403, 'Forbidden', 'You do not have access to this resource');
  }

  const results = await getModelResults(jobId);
  const evaluations = await getEvaluations(jobId);
  const evalByModelId = new Map<string, EvaluationRecord>(
    evaluations.map((e) => [e.modelId, e]),
  );

  // Generate presigned URL for audio playback (15 min expiry)
  let audioUrl: string | undefined;
  if (job.s3Key && AUDIO_BUCKET) {
    audioUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: AUDIO_BUCKET, Key: job.s3Key }),
      { expiresIn: 900 },
    );
  }

  // Fetch ground truth text if present
  let groundTruthText: string | undefined;
  if (job.groundTruthS3Key && AUDIO_BUCKET) {
    try {
      const gtResponse = await s3Client.send(
        new GetObjectCommand({ Bucket: AUDIO_BUCKET, Key: job.groundTruthS3Key }),
      );
      groundTruthText = await gtResponse.Body?.transformToString('utf-8');
    } catch (err) {
      console.warn('Failed to fetch ground truth text:', err);
    }
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(toJobDetail(job, results, evalByModelId, audioUrl, groundTruthText)),
  };
}

function toJobSummary(job: JobRecord) {
  return {
    jobId: job.jobId,
    status: job.status,
    modelIds: job.modelIds,
    createdAt: job.createdAt,
    ...(job.completedAt && { completedAt: job.completedAt }),
  };
}

function toJobDetail(
  job: JobRecord,
  results: ModelResultRecord[],
  evalByModelId: Map<string, EvaluationRecord>,
  audioUrl?: string,
  groundTruthText?: string,
) {
  return {
    jobId: job.jobId,
    userId: job.userId,
    status: job.status,
    s3Key: job.s3Key,
    audioUrl,
    groundTruthText,
    modelIds: job.modelIds,
    results: results.map((r) => {
      const evalRow = evalByModelId.get(r.modelId);
      return {
        modelId: r.modelId,
        status: r.status,
        transcriptionText: r.transcriptionText,
        errorMessage: r.errorMessage,
        errorCode: r.errorCode,
        errorDetails: r.errorDetails,
        latencyMs: r.latencyMs,
        estimatedCostUsd: r.estimatedCostUsd,
        completedAt: r.completedAt,
        ...(evalRow && {
          evaluation: {
            status: evalRow.status,
            ...(evalRow.wer != null && { wer: evalRow.wer }),
            ...(evalRow.mer != null && { mer: evalRow.mer }),
            ...(evalRow.merTotal != null && { merTotal: evalRow.merTotal }),
            ...(evalRow.merMissed != null && { merMissed: evalRow.merMissed }),
            ...(evalRow.semanticWer != null && { semanticWer: evalRow.semanticWer }),
            ...(evalRow.llmJudge != null && { llmJudge: evalRow.llmJudge }),
            ...(evalRow.errorMessage != null && { errorMessage: evalRow.errorMessage }),
            ...(evalRow.errors != null && { errors: evalRow.errors }),
          },
        }),
      };
    }),
    createdAt: job.createdAt,
    ...(job.startedAt && { startedAt: job.startedAt }),
    ...(job.completedAt && { completedAt: job.completedAt }),
  };
}

async function handleDeleteJob(
  userId: string,
  jobId: string,
): Promise<APIGatewayProxyResult> {
  const job = await getJobById(jobId);

  if (!job) {
    return errorResponse(404, 'NotFound', 'Job not found');
  }

  if (job.userId !== userId) {
    return errorResponse(403, 'Forbidden', 'You do not have access to this resource');
  }

  await deleteJobAndResults(userId, jobId);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ message: 'Job deleted' }),
  };
}

function errorResponse(
  statusCode: number,
  error: string,
  message: string,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error, message }),
  };
}
