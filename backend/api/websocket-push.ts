import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { getJobById, getModelResults, buildConnPK, updateJobStatus } from '../shared/dynamodb';
import { EvaluationStatus, ModelStatus, JobStatus, WebSocketMessage } from '../shared/types';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT ?? '';

const TERMINAL_STATUSES: ModelStatus[] = ['COMPLETED', 'ERROR', 'TIMED_OUT'];

let docClient: DynamoDBDocumentClient;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

let apigwClient: ApiGatewayManagementApiClient;

function getApigwClient(): ApiGatewayManagementApiClient {
  if (!apigwClient) {
    apigwClient = new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_ENDPOINT });
  }
  return apigwClient;
}

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'WEBSOCKET_PUSH_RECORD_ERROR',
        eventID: record.eventID,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      }));
    }
  }
};

async function processRecord(record: DynamoDBRecord): Promise<void> {
  // Only process INSERT or MODIFY events
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') {
    return;
  }

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) {
    return;
  }

  const item = unmarshall(newImage as Record<string, any>);
  const pk = item.PK as string;
  const sk = item.SK as string;

  // Two row types under JOB# partition: RESULT# (transcription) and EVAL# (metrics).
  // Each follows its own push path; everything else is ignored.
  if (pk?.startsWith('JOB#') && sk?.startsWith('EVAL#')) {
    await processEvaluationRow(pk, sk, item);
    return;
  }

  if (pk?.startsWith('JOB#') && sk?.startsWith('RESULT#')) {
    await processResultRow(pk, sk, item);
    return;
  }
}

async function processResultRow(pk: string, sk: string, item: Record<string, any>): Promise<void> {
  const status = item.status as ModelStatus;

  // Push for any terminal status the workers can produce. Without TIMED_OUT
  // here the frontend would sit at PROCESSING forever for SageMaker timeouts.
  if (status !== 'COMPLETED' && status !== 'ERROR' && status !== 'TIMED_OUT') {
    return;
  }

  const jobId = pk.replace('JOB#', '');
  const modelId = sk.replace('RESULT#', '');

  // Look up the job record to get the userId
  const job = await getJobById(jobId);
  if (!job) {
    console.warn(JSON.stringify({
      event: 'WEBSOCKET_PUSH_JOB_NOT_FOUND',
      jobId,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  const userId = job.userId;

  // Query active connections for this user
  const connections = await queryUserConnections(userId);

  // Push RESULT message to connected clients (if any).
  // We forward the friendly errorMessage / errorCode / errorDetails the worker
  // wrote — without these the frontend used to fall back to "Error" until the
  // user reloaded the page and the REST endpoint returned the full record.
  if (connections.length > 0) {
    const resultMessage: WebSocketMessage = {
      action: 'RESULT',
      jobId,
      modelId,
      transcriptionText: item.transcriptionText,
      status,
      ...(item.errorMessage != null && { errorMessage: item.errorMessage as string }),
      ...(item.errorCode != null && { errorCode: item.errorCode }),
      ...(item.errorDetails != null && { errorDetails: item.errorDetails as string }),
      metrics: item.latencyMs != null && item.estimatedCostUsd != null
        ? { latencyMs: item.latencyMs, estimatedCostUsd: item.estimatedCostUsd }
        : undefined,
      timestamp: new Date().toISOString(),
    };

    await postToConnections(userId, connections, resultMessage);
  }

  // Check if all models are done — update job status regardless of connections
  const allResults = await getModelResults(jobId);
  const expectedModelCount = job.modelIds.length;
  const allTerminal = allResults.length >= expectedModelCount &&
    allResults.every((r) => TERMINAL_STATUSES.includes(r.status));

  if (allTerminal) {
    const hasFailure = allResults.some((r) => r.status === 'ERROR' || r.status === 'TIMED_OUT');
    const jobStatus: JobStatus = hasFailure ? 'FAILED' : 'COMPLETED';
    const now = new Date().toISOString();

    // Always update the parent job record in DynamoDB
    await updateJobStatus(userId, jobId, jobStatus, now);

    // Push JOB_COMPLETE to connected clients (if any)
    const activeConnections = await queryUserConnections(userId);
    if (activeConnections.length > 0) {
      const completeMessage: WebSocketMessage = {
        action: 'JOB_COMPLETE',
        jobId,
        status: hasFailure ? 'ERROR' : 'COMPLETED',
        timestamp: now,
      };
      await postToConnections(userId, activeConnections, completeMessage);
    }

    console.log(JSON.stringify({
      event: 'JOB_COMPLETE',
      jobId,
      userId,
      resultCount: allResults.length,
      timestamp: new Date().toISOString(),
    }));
  }
}

async function processEvaluationRow(pk: string, sk: string, item: Record<string, any>): Promise<void> {
  // Push for any terminal state — clients want to know about COMPLETED, ERROR, and SKIPPED.
  // (PENDING is never written today but treat it as a no-op for safety.)
  const status = item.status as string;
  if (status === 'PENDING') return;

  const jobId = pk.replace('JOB#', '');
  const modelId = sk.replace('EVAL#', '');

  const job = await getJobById(jobId);
  if (!job) return;

  const connections = await queryUserConnections(job.userId);
  if (connections.length === 0) return;

  const message: WebSocketMessage = {
    action: 'EVALUATION',
    jobId,
    modelId,
    evaluation: {
      status: status as EvaluationStatus,
      ...(item.wer != null && { wer: item.wer }),
      ...(item.mer != null && { mer: item.mer }),
      ...(item.merTotal != null && { merTotal: item.merTotal }),
      ...(item.merMissed != null && { merMissed: item.merMissed }),
      ...(item.semanticWer != null && { semanticWer: item.semanticWer }),
      ...(item.llmJudge != null && { llmJudge: item.llmJudge }),
      ...(item.errorMessage != null && { errorMessage: item.errorMessage }),
      ...(item.errors != null && { errors: item.errors }),
    },
    timestamp: new Date().toISOString(),
  };

  await postToConnections(job.userId, connections, message);
}

async function queryUserConnections(userId: string): Promise<string[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': buildConnPK(userId),
        ':skPrefix': 'CONN#',
      },
    }),
  );

  return (result.Items ?? []).map((item) => item.connectionId as string);
}

async function postToConnections(
  userId: string,
  connectionIds: string[],
  message: WebSocketMessage,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(message));
  const client = getApigwClient();

  for (const connectionId of connectionIds) {
    try {
      await client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: payload,
        }),
      );
    } catch (error: any) {
      if (error.name === 'GoneException' || error.statusCode === 410) {
        // Connection is stale — delete it
        await deleteStaleConnection(userId, connectionId);
      } else {
        console.error(JSON.stringify({
          event: 'WEBSOCKET_POST_ERROR',
          connectionId,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }
}

async function deleteStaleConnection(userId: string, connectionId: string): Promise<void> {
  const client = getDocClient();

  try {
    // Delete the connection record
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: buildConnPK(userId),
          SK: `CONN#${connectionId}`,
        },
      }),
    );

    // Delete the reverse lookup record
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `CONNID#${connectionId}`,
          SK: 'META',
        },
      }),
    );

    console.log(JSON.stringify({
      event: 'STALE_CONNECTION_DELETED',
      userId,
      connectionId,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'STALE_CONNECTION_DELETE_ERROR',
      userId,
      connectionId,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));
  }
}
