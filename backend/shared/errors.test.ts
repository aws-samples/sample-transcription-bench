import { mapWorkerError, ErrorContext } from './errors';

const bedrockMini: ErrorContext = {
  modelId: 'bedrock-voxtral-mini',
  modelName: 'Mistral Voxtral Mini 3B',
  provider: 'bedrock',
};

const sagemakerWhisper: ErrorContext = {
  modelId: 'sagemaker-whisper-large-v3',
  modelName: 'Distil-Whisper Large v3',
  provider: 'sagemaker',
};

const transcribeStd: ErrorContext = {
  modelId: 'transcribe-standard',
  modelName: 'AWS Transcribe Standard',
  provider: 'transcribe',
};

/**
 * Build an AWS-SDK-shaped error. The mapper inspects `name`,
 * `$metadata.httpStatusCode`, and the message text — mirror that here.
 */
function awsError(name: string, message: string, status?: number): Error {
  const err = new Error(message);
  (err as { name: string }).name = name;
  (err as { $metadata?: { httpStatusCode?: number } }).$metadata = status
    ? { httpStatusCode: status }
    : undefined;
  return err;
}

describe('mapWorkerError', () => {
  describe('AUDIO_TOO_LONG', () => {
    it('classifies Bedrock ValidationException about duration', () => {
      const result = mapWorkerError(
        awsError('ValidationException', 'Input audio duration exceeds maximum of 30 seconds'),
        bedrockMini,
      );
      expect(result.code).toBe('AUDIO_TOO_LONG');
      expect(result.userMessage).toContain('Voxtral Mini');
      expect(result.userMessage).toContain('25 seconds');
      expect(result.status).toBe('ERROR');
    });

    it('classifies SageMaker 413 PayloadTooLarge', () => {
      const result = mapWorkerError(
        awsError('PayloadTooLargeException', 'Payload too large', 413),
        sagemakerWhisper,
      );
      expect(result.code).toBe('AUDIO_TOO_LONG');
      expect(result.rawMessage).toBe('Payload too large');
    });

    it('mentions Voxtral Small 5-minute hint for the small model', () => {
      const result = mapWorkerError(
        awsError('ValidationException', 'audio length exceeds maximum'),
        { ...bedrockMini, modelId: 'bedrock-voxtral-small', modelName: 'Voxtral Small' },
      );
      expect(result.code).toBe('AUDIO_TOO_LONG');
      expect(result.userMessage).toMatch(/five minutes/);
    });
  });

  describe('QUOTA_EXCEEDED', () => {
    it('detects ServiceQuotaExceededException by name', () => {
      const result = mapWorkerError(
        awsError('ServiceQuotaExceededException', 'You have exceeded your service quota'),
        bedrockMini,
      );
      expect(result.code).toBe('QUOTA_EXCEEDED');
      expect(result.userMessage).toMatch(/quota/);
      expect(result.userMessage).toContain('Voxtral Mini');
    });

    it('detects quota mention in the message text', () => {
      const result = mapWorkerError(
        awsError('Error', 'Account quota reached for InvokeModel'),
        bedrockMini,
      );
      expect(result.code).toBe('QUOTA_EXCEEDED');
    });
  });

  describe('RATE_LIMITED', () => {
    it('detects ThrottlingException', () => {
      const result = mapWorkerError(
        awsError('ThrottlingException', 'Too many requests'),
        bedrockMini,
      );
      expect(result.code).toBe('RATE_LIMITED');
    });

    it('detects HTTP 429 even with a generic name', () => {
      const result = mapWorkerError(
        awsError('Error', 'Slow down', 429),
        bedrockMini,
      );
      expect(result.code).toBe('RATE_LIMITED');
    });
  });

  describe('MODEL_TIMEOUT', () => {
    it('produces TIMED_OUT status for SageMaker timeout', () => {
      const result = mapWorkerError(
        awsError('ModelTimeoutException', 'Endpoint did not respond in time'),
        sagemakerWhisper,
      );
      expect(result.code).toBe('MODEL_TIMEOUT');
      expect(result.status).toBe('TIMED_OUT');
      expect(result.userMessage).toMatch(/cold-starting/);
    });

    it('detects "timed out" in custom Transcribe error', () => {
      const result = mapWorkerError(
        new Error('Transcribe job timed out after 240000ms (status: IN_PROGRESS)'),
        transcribeStd,
      );
      expect(result.code).toBe('MODEL_TIMEOUT');
      expect(result.status).toBe('TIMED_OUT');
    });
  });

  describe('PERMISSION_DENIED', () => {
    it('detects AccessDeniedException', () => {
      const result = mapWorkerError(
        awsError('AccessDeniedException', 'You don\'t have access to this model', 403),
        bedrockMini,
      );
      expect(result.code).toBe('PERMISSION_DENIED');
      expect(result.userMessage).toMatch(/Access to/);
    });
  });

  describe('MODEL_UNAVAILABLE', () => {
    it('detects ResourceNotFoundException', () => {
      const result = mapWorkerError(
        awsError('ResourceNotFoundException', 'Model not found'),
        bedrockMini,
      );
      expect(result.code).toBe('MODEL_UNAVAILABLE');
    });

    it('detects HTTP 503', () => {
      const result = mapWorkerError(
        awsError('ServiceUnavailable', 'Service unavailable', 503),
        sagemakerWhisper,
      );
      expect(result.code).toBe('MODEL_UNAVAILABLE');
    });
  });

  describe('ENDPOINT_NOT_FOUND', () => {
    it('detects the SageMaker endpoint-mapping error from the worker', () => {
      const result = mapWorkerError(
        new Error('No SageMaker endpoint mapping found for modelId: sagemaker-qwen-asr'),
        { modelId: 'sagemaker-qwen-asr', modelName: 'Qwen3 ASR 0.6B', provider: 'sagemaker' },
      );
      expect(result.code).toBe('ENDPOINT_NOT_FOUND');
      expect(result.userMessage).toContain('Qwen3 ASR');
    });
  });

  describe('UNKNOWN', () => {
    it('falls back to UNKNOWN with the raw message preserved', () => {
      const result = mapWorkerError(
        awsError('SomeNewException', 'an unexpected thing happened'),
        bedrockMini,
      );
      expect(result.code).toBe('UNKNOWN');
      expect(result.rawMessage).toBe('an unexpected thing happened');
      expect(result.status).toBe('ERROR');
    });

    it('handles non-Error throws', () => {
      const result = mapWorkerError('string thrown directly', bedrockMini);
      expect(result.code).toBe('UNKNOWN');
      expect(result.rawMessage).toBe('string thrown directly');
    });
  });

  it('uses modelId when modelName is missing', () => {
    const result = mapWorkerError(
      awsError('ThrottlingException', 'Too many requests'),
      { modelId: 'some-model', provider: 'bedrock' },
    );
    expect(result.userMessage).toContain('some-model');
  });
});
