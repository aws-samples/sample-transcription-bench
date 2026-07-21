/**
 * Centralized error normalization for transcription workers.
 *
 * Workers run against three very different AWS services (Bedrock, SageMaker,
 * Transcribe) which throw a wide variety of SDK exceptions. Surfacing those
 * raw to the UI is unhelpful — "ValidationException: input audio exceeds
 * maximum duration" or "ModelError: Internal Server Error" tells the user
 * nothing actionable.
 *
 * `mapWorkerError` inspects an unknown thrown value and produces:
 *   - `code`        — a stable enum the frontend can switch on
 *   - `userMessage` — a friendly headline including the model name
 *   - `rawMessage`  — the original SDK message, for the "details" disclosure
 *   - `status`     — the worker status to record (TIMED_OUT vs ERROR)
 */

export type ErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'AUDIO_TOO_LONG'
  | 'INVALID_AUDIO'
  | 'MODEL_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'ENDPOINT_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN';

export interface MappedError {
  code: ErrorCode;
  userMessage: string;
  rawMessage: string;
  status: 'ERROR' | 'TIMED_OUT';
}

export interface ErrorContext {
  modelId: string;
  modelName?: string;
  provider: 'bedrock' | 'sagemaker' | 'transcribe';
}

interface AwsLikeError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

function asAwsError(err: unknown): AwsLikeError {
  if (err && typeof err === 'object') {
    return err as AwsLikeError;
  }
  return { message: String(err) };
}

/**
 * Heuristics: AWS rarely surfaces "this is an audio-length problem" via a
 * dedicated exception. Bedrock returns `ValidationException` with a message
 * mentioning duration/length/seconds. SageMaker returns 413 with
 * "PayloadTooLarge". Both should map to AUDIO_TOO_LONG.
 */
function looksLikeAudioTooLong(name: string, message: string, status?: number): boolean {
  if (status === 413) return true;
  if (/payload\s*too\s*large/i.test(message)) return true;
  if (/payload\s*too\s*large/i.test(name)) return true;
  if (name === 'RequestEntityTooLargeException') return true;
  if (name === 'ValidationException' && /(duration|length|too\s*long|exceeds?|seconds|max(?:imum)?\s*audio)/i.test(message)) {
    return true;
  }
  return false;
}

function looksLikeQuota(name: string, message: string): boolean {
  if (name === 'ServiceQuotaExceededException') return true;
  if (/service\s*quota/i.test(message)) return true;
  if (/quota\s*(exceeded|reached|limit)/i.test(message)) return true;
  return false;
}

function looksLikeThrottling(name: string, message: string, status?: number): boolean {
  if (status === 429) return true;
  if (name === 'ThrottlingException') return true;
  if (name === 'TooManyRequestsException') return true;
  if (/too many requests/i.test(message)) return true;
  if (/throttl/i.test(message)) return true;
  return false;
}

function looksLikeTimeout(name: string, message: string): boolean {
  if (name === 'ModelTimeoutException') return true;
  if (name === 'TimeoutError') return true;
  if (/timed?\s*out/i.test(message)) return true;
  if (/deadline\s*exceeded/i.test(message)) return true;
  return false;
}

function looksLikeUnavailable(name: string, message: string, status?: number): boolean {
  if (name === 'ModelNotReadyException') return true;
  if (name === 'ServiceUnavailableException' || name === 'ServiceUnavailable') return true;
  if (status === 503) return true;
  if (/model\s*(is\s*)?not\s*ready/i.test(message)) return true;
  if (name === 'ResourceNotFoundException') return true;
  return false;
}

function looksLikePermission(name: string, message: string, status?: number): boolean {
  if (name === 'AccessDeniedException') return true;
  if (name === 'UnrecognizedClientException') return true;
  if (status === 403) return true;
  if (/access\s*denied/i.test(message)) return true;
  if (/not\s*authori[sz]ed/i.test(message)) return true;
  return false;
}

function looksLikeEndpointMissing(message: string): boolean {
  return /no\s*sagemaker\s*endpoint\s*mapping/i.test(message);
}

function looksLikeInvalidAudio(name: string, message: string): boolean {
  if (name === 'BadRequestException' && /(invalid|unsupported|format|codec|decode)/i.test(message)) return true;
  if (/(unsupported\s*format|invalid\s*audio|cannot\s*decode|corrupt(ed)?\s*audio)/i.test(message)) return true;
  return false;
}

function modelLabel(ctx: ErrorContext): string {
  return ctx.modelName ?? ctx.modelId;
}

/**
 * Heuristic max-clip-length for Voxtral models. The Bedrock validation
 * threshold isn't published as a stable number, but in practice clips
 * over ~25-30s on Mini and ~5min on Small fail with a length error.
 */
function audioTooLongHint(ctx: ErrorContext): string {
  if (ctx.modelId === 'bedrock-voxtral-mini') {
    return ' Voxtral Mini accepts roughly 25 seconds of audio per request — try Voxtral Small, Whisper, or AWS Transcribe for longer clips.';
  }
  if (ctx.modelId === 'bedrock-voxtral-small') {
    return ' Voxtral Small accepts roughly five minutes of audio per request — try Whisper or AWS Transcribe for longer clips.';
  }
  if (ctx.provider === 'sagemaker') {
    return ' The audio file is larger than the SageMaker endpoint accepts in a single request.';
  }
  return '';
}

export function mapWorkerError(error: unknown, ctx: ErrorContext): MappedError {
  const e = asAwsError(error);
  const name = e.name ?? '';
  const message = e.message ?? String(error);
  const status = e.$metadata?.httpStatusCode;
  const label = modelLabel(ctx);

  if (looksLikeEndpointMissing(message)) {
    return {
      code: 'ENDPOINT_NOT_FOUND',
      userMessage: `${label} isn't deployed in this environment.`,
      rawMessage: message,
      status: 'ERROR',
    };
  }

  if (looksLikeAudioTooLong(name, message, status)) {
    return {
      code: 'AUDIO_TOO_LONG',
      userMessage: `Audio is too long for ${label}.${audioTooLongHint(ctx)}`,
      rawMessage: message,
      status: 'ERROR',
    };
  }

  if (looksLikeQuota(name, message)) {
    return {
      code: 'QUOTA_EXCEEDED',
      userMessage: `Your AWS account quota for ${label} has been reached. Try again later, choose a shorter clip, or request a quota increase in the AWS console.`,
      rawMessage: message,
      status: 'ERROR',
    };
  }

  if (looksLikeThrottling(name, message, status)) {
    return {
      code: 'RATE_LIMITED',
      userMessage: `${label} is rate-limiting requests right now. Wait a moment and rerun this comparison.`,
      rawMessage: message,
      status: 'ERROR',
    };
  }

  if (looksLikeTimeout(name, message)) {
    return {
      code: 'MODEL_TIMEOUT',
      userMessage:
        ctx.provider === 'sagemaker'
          ? `${label} didn't respond within the SageMaker invocation timeout. The endpoint may be cold-starting — retry in a moment, or try a shorter audio clip.`
          : `${label} timed out before producing a transcription. This usually clears on retry.`,
      rawMessage: message,
      status: 'TIMED_OUT',
    };
  }

  if (looksLikeUnavailable(name, message, status)) {
    return {
      code: 'MODEL_UNAVAILABLE',
      userMessage: `${label} is currently unavailable. The endpoint may be scaling up or the model isn't enabled in this region.`,
      rawMessage: message,
      status: 'ERROR',
    };
  }

  if (looksLikePermission(name, message, status)) {
    return {
      code: 'PERMISSION_DENIED',
      userMessage: `Access to ${label} isn't enabled for this AWS account. Check the model access page in the AWS console.`,
      rawMessage: message,
      status: 'ERROR',
    };
  }

  if (looksLikeInvalidAudio(name, message)) {
    return {
      code: 'INVALID_AUDIO',
      userMessage: `${label} couldn't process this audio file. Make sure it's a valid WAV file.`,
      rawMessage: message,
      status: 'ERROR',
    };
  }

  return {
    code: 'UNKNOWN',
    userMessage: `${label} failed unexpectedly. See details below.`,
    rawMessage: message,
    status: 'ERROR',
  };
}
