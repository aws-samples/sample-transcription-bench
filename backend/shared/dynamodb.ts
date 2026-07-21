import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { EvaluationRecord, JobRecord, JobStatus, ModelResultRecord } from './types';

let docClient: DynamoDBDocumentClient;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

const TABLE_NAME = process.env.TABLE_NAME ?? '';

// --- Key builders ---

export function buildJobPK(userId: string): string {
  return `USER#${userId}`;
}

export function buildJobSK(jobId: string): string {
  return `JOB#${jobId}`;
}

export function buildResultPK(jobId: string): string {
  return `JOB#${jobId}`;
}

export function buildResultSK(modelId: string): string {
  return `RESULT#${modelId}`;
}

// Evaluation rows live under the same JOB# partition as model results so they
// can be queried alongside them, but use a distinct SK prefix so the existing
// stream consumer can filter on `RESULT#` without picking up evaluation events.
export function buildEvalPK(jobId: string): string {
  return `JOB#${jobId}`;
}

export function buildEvalSK(modelId: string): string {
  return `EVAL#${modelId}`;
}

export function buildConnPK(userId: string): string {
  return `CONN#${userId}`;
}

export function buildConnSK(connectionId: string): string {
  return `CONN#${connectionId}`;
}

// --- Write operations ---

export async function writeJobRecord(record: JobRecord): Promise<void> {
  await getDocClient().send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }),
  );
}

export async function writeModelResult(record: ModelResultRecord): Promise<void> {
  await getDocClient().send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }),
  );
}

export async function writeEvaluation(record: EvaluationRecord): Promise<void> {
  await getDocClient().send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }),
  );
}

// --- Query operations ---

export async function queryJobsByUser(
  userId: string,
  limit = 20,
  cursor?: string,
): Promise<{ items: JobRecord[]; nextCursor?: string }> {
  const exclusiveStartKey = cursor
    ? JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'))
    : undefined;

  const result = await getDocClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': buildJobPK(userId),
        ':skPrefix': 'JOB#',
      },
      ScanIndexForward: false,
      Limit: limit,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    }),
  );

  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : undefined;

  return {
    items: (result.Items ?? []) as JobRecord[],
    nextCursor,
  };
}

export async function getJobById(jobId: string): Promise<JobRecord | undefined> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'JobLookup',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
      ExpressionAttributeValues: {
        ':pk': `JOB#${jobId}`,
        ':sk': 'META',
      },
      Limit: 1,
    }),
  );

  return (result.Items?.[0] as JobRecord) ?? undefined;
}

export async function getModelResults(jobId: string): Promise<ModelResultRecord[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': buildResultPK(jobId),
        ':skPrefix': 'RESULT#',
      },
    }),
  );

  return (result.Items ?? []) as ModelResultRecord[];
}

export async function getEvaluations(jobId: string): Promise<EvaluationRecord[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': buildEvalPK(jobId),
        ':skPrefix': 'EVAL#',
      },
    }),
  );

  return (result.Items ?? []) as EvaluationRecord[];
}

export async function updateJobStatus(
  userId: string,
  jobId: string,
  status: JobStatus,
  completedAt?: string,
): Promise<void> {
  const updateExpr = completedAt
    ? 'SET #s = :status, completedAt = :completedAt'
    : 'SET #s = :status';

  const exprValues: Record<string, unknown> = { ':status': status };
  if (completedAt) {
    exprValues[':completedAt'] = completedAt;
  }

  await getDocClient().send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: buildJobPK(userId),
        SK: buildJobSK(jobId),
      },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: exprValues,
    }),
  );
}

export async function deleteJobAndResults(
  userId: string,
  jobId: string,
): Promise<void> {
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  const client = getDocClient();

  // Delete model results
  const results = await getModelResults(jobId);
  for (const result of results) {
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: result.PK, SK: result.SK },
      }),
    );
  }

  // Delete evaluation rows (if any)
  const evaluations = await getEvaluations(jobId);
  for (const evalRow of evaluations) {
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: evalRow.PK, SK: evalRow.SK },
      }),
    );
  }

  // Delete the job record
  await client.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: buildJobPK(userId),
        SK: buildJobSK(jobId),
      },
    }),
  );
}
