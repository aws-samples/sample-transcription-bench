import {
  buildJobPK,
  buildJobSK,
  buildResultPK,
  buildResultSK,
  buildConnPK,
  buildConnSK,
  writeJobRecord,
  writeModelResult,
  queryJobsByUser,
  getJobById,
  getModelResults,
} from './dynamodb';
import { JobRecord, ModelResultRecord } from './types';

// Set table name env var
process.env.TABLE_NAME = 'TestJobTable';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockImplementation(() => ({
      send: (...args: unknown[]) => mockSend(...args),
    })),
  },
  PutCommand: jest.fn().mockImplementation((input: unknown) => ({ _type: 'Put', input })),
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({ _type: 'Query', input })),
}));

describe('DynamoDB key builders', () => {
  test('buildJobPK returns USER# prefix', () => {
    expect(buildJobPK('user-123')).toBe('USER#user-123');
  });

  test('buildJobSK returns JOB# prefix', () => {
    expect(buildJobSK('job-456')).toBe('JOB#job-456');
  });

  test('buildResultPK returns JOB# prefix', () => {
    expect(buildResultPK('job-456')).toBe('JOB#job-456');
  });

  test('buildResultSK returns RESULT# prefix', () => {
    expect(buildResultSK('bedrock-nova-sonic')).toBe('RESULT#bedrock-nova-sonic');
  });

  test('buildConnPK returns CONN# prefix', () => {
    expect(buildConnPK('user-123')).toBe('CONN#user-123');
  });

  test('buildConnSK returns CONN# prefix', () => {
    expect(buildConnSK('conn-789')).toBe('CONN#conn-789');
  });
});

describe('writeJobRecord', () => {
  beforeEach(() => mockSend.mockReset());

  test('sends PutCommand with the job record', async () => {
    mockSend.mockResolvedValueOnce({});
    const record: JobRecord = {
      PK: 'USER#u1',
      SK: 'JOB#j1',
      GSI1PK: 'JOB#j1',
      GSI1SK: 'META',
      jobId: 'j1',
      userId: 'u1',
      status: 'PENDING',
      s3Key: 'u1/uuid/file.wav',
      s3Bucket: 'audio-bucket',
      modelIds: ['bedrock-nova-sonic', 'transcribe-standard'],
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    await writeJobRecord(record);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('writeModelResult', () => {
  beforeEach(() => mockSend.mockReset());

  test('sends PutCommand with the model result record', async () => {
    mockSend.mockResolvedValueOnce({});
    const record: ModelResultRecord = {
      PK: 'JOB#j1',
      SK: 'RESULT#bedrock-nova-sonic',
      jobId: 'j1',
      modelId: 'bedrock-nova-sonic',
      status: 'COMPLETED',
      transcriptionText: 'Hello world',
      latencyMs: 1200,
      estimatedCostUsd: 0.003,
      completedAt: '2024-01-01T00:01:00.000Z',
    };

    await writeModelResult(record);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('queryJobsByUser', () => {
  beforeEach(() => mockSend.mockReset());

  test('returns items and no cursor when no LastEvaluatedKey', async () => {
    const mockJob: JobRecord = {
      PK: 'USER#u1',
      SK: 'JOB#j1',
      GSI1PK: 'JOB#j1',
      GSI1SK: 'META',
      jobId: 'j1',
      userId: 'u1',
      status: 'COMPLETED',
      s3Key: 'u1/uuid/file.wav',
      s3Bucket: 'audio-bucket',
      modelIds: ['bedrock-nova-sonic', 'transcribe-standard'],
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    mockSend.mockResolvedValueOnce({ Items: [mockJob] });

    const result = await queryJobsByUser('u1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].jobId).toBe('j1');
    expect(result.nextCursor).toBeUndefined();
  });

  test('returns base64-encoded cursor when LastEvaluatedKey present', async () => {
    const lastKey = { PK: 'USER#u1', SK: 'JOB#j2' };
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });

    const result = await queryJobsByUser('u1', 10);
    expect(result.nextCursor).toBeDefined();
    const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString('utf-8'));
    expect(decoded).toEqual(lastKey);
  });

  test('passes decoded cursor as ExclusiveStartKey', async () => {
    const lastKey = { PK: 'USER#u1', SK: 'JOB#j2' };
    const cursor = Buffer.from(JSON.stringify(lastKey)).toString('base64');
    mockSend.mockResolvedValueOnce({ Items: [] });

    await queryJobsByUser('u1', 10, cursor);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('getJobById', () => {
  beforeEach(() => mockSend.mockReset());

  test('returns job record when found via GSI', async () => {
    const mockJob: JobRecord = {
      PK: 'USER#u1',
      SK: 'JOB#j1',
      GSI1PK: 'JOB#j1',
      GSI1SK: 'META',
      jobId: 'j1',
      userId: 'u1',
      status: 'PENDING',
      s3Key: 'u1/uuid/file.wav',
      s3Bucket: 'audio-bucket',
      modelIds: ['bedrock-nova-sonic', 'transcribe-standard'],
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    mockSend.mockResolvedValueOnce({ Items: [mockJob] });

    const result = await getJobById('j1');
    expect(result).toBeDefined();
    expect(result!.jobId).toBe('j1');
  });

  test('returns undefined when job not found', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await getJobById('nonexistent');
    expect(result).toBeUndefined();
  });
});

describe('getModelResults', () => {
  beforeEach(() => mockSend.mockReset());

  test('returns model result records for a job', async () => {
    const results: ModelResultRecord[] = [
      {
        PK: 'JOB#j1',
        SK: 'RESULT#bedrock-nova-sonic',
        jobId: 'j1',
        modelId: 'bedrock-nova-sonic',
        status: 'COMPLETED',
        transcriptionText: 'Hello',
        latencyMs: 1000,
        estimatedCostUsd: 0.002,
        completedAt: '2024-01-01T00:01:00.000Z',
      },
      {
        PK: 'JOB#j1',
        SK: 'RESULT#transcribe-standard',
        jobId: 'j1',
        modelId: 'transcribe-standard',
        status: 'COMPLETED',
        transcriptionText: 'Hello',
        latencyMs: 2000,
        estimatedCostUsd: 0.005,
        completedAt: '2024-01-01T00:01:30.000Z',
      },
    ];
    mockSend.mockResolvedValueOnce({ Items: results });

    const fetched = await getModelResults('j1');
    expect(fetched).toHaveLength(2);
    expect(fetched[0].modelId).toBe('bedrock-nova-sonic');
    expect(fetched[1].modelId).toBe('transcribe-standard');
  });

  test('returns empty array when no results exist', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const fetched = await getModelResults('j-empty');
    expect(fetched).toHaveLength(0);
  });
});
