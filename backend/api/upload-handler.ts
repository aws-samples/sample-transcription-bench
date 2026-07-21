import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isValidAudioFormat, isValidFileSize, generateS3Key } from '../shared/validation';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;
const PRESIGNED_URL_EXPIRY_SECONDS = 300;

interface UploadRequest {
  fileName: string;
  fileSize: number;
  contentType: string;
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

    let request: UploadRequest;
    try {
      request = JSON.parse(event.body);
    } catch {
      return errorResponse(400, 'BadRequest', 'Invalid JSON in request body');
    }

    if (!request.fileName || !request.contentType || request.fileSize === undefined) {
      return errorResponse(400, 'BadRequest', 'fileName, fileSize, and contentType are required');
    }

    // Validate content type — allow audio formats and text/plain for ground truth
    const isGroundTruth = request.contentType === 'text/plain';
    if (!isValidAudioFormat(request.contentType) && !isGroundTruth) {
      return errorResponse(415, 'UnsupportedMediaType', 'Supported formats: WAV (audio) and TXT (ground truth).');
    }

    // Validate file size (ground truth .txt files capped at 1 MB)
    const maxSize = isGroundTruth ? 1_048_576 : undefined;
    if (isGroundTruth && request.fileSize > maxSize!) {
      return errorResponse(413, 'PayloadTooLarge', 'Ground truth file must be under 1 MB');
    }
    if (!isGroundTruth && !isValidFileSize(request.fileSize)) {
      return errorResponse(413, 'PayloadTooLarge', 'Maximum file size is 500 MB');
    }

    // Generate S3 key
    const s3Key = generateS3Key(userId, request.fileName);

    // Generate pre-signed PUT URL
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: request.contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
    });

    // Log upload event
    console.log(JSON.stringify({
      event: 'UPLOAD_URL_GENERATED',
      userId,
      s3Key,
      fileName: request.fileName,
      fileSize: request.fileSize,
      contentType: request.contentType,
      timestamp: new Date().toISOString(),
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      },
      body: JSON.stringify({
        uploadUrl,
        s3Key,
        expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
      }),
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'UPLOAD_ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));

    return errorResponse(500, 'InternalError', 'An unexpected error occurred');
  }
};

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
