import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
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
const bedrockClient = new BedrockRuntimeClient({});

const BEDROCK_MODEL_MAP: Record<string, string> = {
  'bedrock-voxtral-mini': 'mistral.voxtral-mini-3b-2507',
  'bedrock-voxtral-small': 'mistral.voxtral-small-24b-2507',
};

export const handler = async (event: WorkerEvent): Promise<void> => {
  const startTime = Date.now();
  const { jobId, modelId, s3Key, s3Bucket } = event;

  logger.info({ event: 'worker_started', jobId, modelId, s3Key });

  try {
    // 1. Download audio from S3
    const s3Response = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
    );
    const audioBytes = await s3Response.Body!.transformToByteArray();
    const audioBase64 = Buffer.from(audioBytes).toString('base64');

    // 2. Resolve the actual Bedrock model ID
    const bedrockModelId = BEDROCK_MODEL_MAP[modelId];
    if (!bedrockModelId) {
      throw new Error(`No Bedrock model mapping for: ${modelId}`);
    }

    // 3. Call Bedrock InvokeModel with Voxtral input_audio format
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format: 'wav',
              },
            },
            {
              type: 'text',
              text: 'Transcribe this audio exactly as spoken. Return only the transcription text.',
            },
          ],
        },
      ],
      max_tokens: 4096,
    };

    const bedrockResponse = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: bedrockModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      }),
    );

    // 4. Parse response
    const responseBody = JSON.parse(
      new TextDecoder().decode(bedrockResponse.body),
    );

    logger.info({ event: 'bedrock_response_keys', keys: Object.keys(responseBody) });

    const transcriptionText: string =
      responseBody.choices?.[0]?.message?.content ?? '';

    // 5. Calculate latency and cost
    const latencyMs = Date.now() - startTime;
    const catalogEntry = MODEL_CATALOG.find((m) => m.modelId === modelId);
    const usage = responseBody.usage ?? {};
    const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const inputCost = ((catalogEntry?.inputCostPer1kTokens ?? 0) / 1000) * inputTokens;
    const outputCost = ((catalogEntry?.outputCostPer1kTokens ?? 0) / 1000) * outputTokens;
    const estimatedCostUsd = parseFloat((inputCost + outputCost).toFixed(6));

    // 6. Write success result to DynamoDB
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
      provider: 'bedrock',
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
