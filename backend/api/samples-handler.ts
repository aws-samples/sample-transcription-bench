import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;
const SAMPLES_PREFIX = 'samples/';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

interface SampleAudio {
  name: string;
  s3Key: string;
  sizeBytes: number;
  previewUrl: string;
}

export const handler = async (
  _event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: SAMPLES_PREFIX,
      }),
    );

    const samples: SampleAudio[] = [];

    for (const obj of result.Contents ?? []) {
      if (!obj.Key || obj.Key === SAMPLES_PREFIX) continue;

      // Extract filename from key (samples/harvard.wav -> harvard.wav)
      const name = obj.Key.slice(SAMPLES_PREFIX.length);
      if (!name) continue;

      // Generate a short-lived presigned URL for audio preview
      const previewUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key }),
        { expiresIn: 900 },
      );

      samples.push({
        name,
        s3Key: obj.Key,
        sizeBytes: obj.Size ?? 0,
        previewUrl,
      });
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(samples),
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'SAMPLES_HANDLER_ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'InternalError',
        message: 'An unexpected error occurred',
      }),
    };
  }
};
