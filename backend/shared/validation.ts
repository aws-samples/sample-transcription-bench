import { v4 as uuidv4 } from 'uuid';
import { MODEL_CATALOG } from './model-catalog';

/**
 * Supported audio MIME types.
 *
 * WAV is the only format currently validated end-to-end across all four
 * model providers (Bedrock Voxtral, SageMaker Whisper / Qwen, AWS Transcribe).
 * Other containers (MP3 / FLAC / OGG / M4A) need per-model handling we
 * haven't tested yet, so we reject them at upload time.
 */
export const SUPPORTED_AUDIO_FORMATS = [
  'audio/wav',
] as const;

/** Maximum file size in bytes (500 MB) */
export const MAX_FILE_SIZE_BYTES = 524_288_000;

/** Minimum number of models for comparison */
export const MIN_MODEL_COUNT = 2;

/** Maximum number of models for comparison */
export const MAX_MODEL_COUNT = 5;

/**
 * Validates whether the given content type is a supported audio format.
 */
export function isValidAudioFormat(contentType: string): boolean {
  return (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(contentType);
}

/**
 * Validates whether the given file size (in bytes) is within the allowed limit.
 */
export function isValidFileSize(bytes: number): boolean {
  return bytes >= 0 && bytes <= MAX_FILE_SIZE_BYTES;
}

/**
 * Validates that 2–5 valid model IDs are provided.
 * Model IDs must exist in the MODEL_CATALOG.
 */
export function isValidModelSelection(modelIds: string[]): boolean {
  if (modelIds.length < MIN_MODEL_COUNT || modelIds.length > MAX_MODEL_COUNT) {
    return false;
  }
  const catalogIds = new Set(MODEL_CATALOG.map((m) => m.modelId));
  return modelIds.every((id) => catalogIds.has(id));
}

/**
 * Generates an S3 object key in the format: {userId}/{uuid}/{fileName}
 */
export function generateS3Key(userId: string, fileName: string): string {
  return `${userId}/${uuidv4()}/${fileName}`;
}
