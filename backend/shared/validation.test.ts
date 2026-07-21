import {
  isValidAudioFormat,
  isValidFileSize,
  isValidModelSelection,
  generateS3Key,
  SUPPORTED_AUDIO_FORMATS,
  MAX_FILE_SIZE_BYTES,
} from './validation';

describe('isValidAudioFormat', () => {
  it.each(SUPPORTED_AUDIO_FORMATS)('accepts supported format: %s', (format) => {
    expect(isValidAudioFormat(format)).toBe(true);
  });

  it.each([
    'audio/mpeg',
    'audio/flac',
    'audio/ogg',
    'audio/mp4',
    'audio/aac',
    'video/mp4',
    'text/plain',
    'application/json',
    '',
  ])('rejects unsupported format: %s', (format) => {
    expect(isValidAudioFormat(format)).toBe(false);
  });
});

describe('isValidFileSize', () => {
  it('accepts 0 bytes', () => {
    expect(isValidFileSize(0)).toBe(true);
  });

  it('accepts exactly 500 MB', () => {
    expect(isValidFileSize(MAX_FILE_SIZE_BYTES)).toBe(true);
  });

  it('rejects 500 MB + 1 byte', () => {
    expect(isValidFileSize(MAX_FILE_SIZE_BYTES + 1)).toBe(false);
  });

  it('rejects negative size', () => {
    expect(isValidFileSize(-1)).toBe(false);
  });
});

describe('isValidModelSelection', () => {
  it('accepts exactly 2 valid model IDs', () => {
    expect(isValidModelSelection(['bedrock-voxtral-mini', 'transcribe-standard'])).toBe(true);
  });

  it('accepts 3 valid model IDs', () => {
    expect(isValidModelSelection(['bedrock-voxtral-mini', 'transcribe-standard', 'sagemaker-whisper-large-v3'])).toBe(true);
  });

  it('accepts 5 valid model IDs (maximum)', () => {
    expect(isValidModelSelection(['bedrock-voxtral-mini', 'bedrock-voxtral-small', 'transcribe-standard', 'sagemaker-whisper-large-v3', 'sagemaker-qwen-asr'])).toBe(true);
  });

  it('rejects fewer than 2 models', () => {
    expect(isValidModelSelection(['bedrock-voxtral-mini'])).toBe(false);
  });

  it('rejects more than 5 models', () => {
    expect(isValidModelSelection(['bedrock-voxtral-mini', 'bedrock-voxtral-small', 'transcribe-standard', 'sagemaker-whisper-large-v3', 'sagemaker-qwen-asr', 'bedrock-voxtral-mini'])).toBe(false);
  });

  it('rejects empty array', () => {
    expect(isValidModelSelection([])).toBe(false);
  });

  it('rejects invalid model IDs', () => {
    expect(isValidModelSelection(['bedrock-voxtral-mini', 'nonexistent-model'])).toBe(false);
  });

  it('rejects 2 invalid model IDs', () => {
    expect(isValidModelSelection(['fake-model-1', 'fake-model-2'])).toBe(false);
  });
});

describe('generateS3Key', () => {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('produces key in {userId}/{uuid}/{fileName} format', () => {
    const key = generateS3Key('user-123', 'recording.wav');
    const parts = key.split('/');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('user-123');
    expect(parts[1]).toMatch(uuidV4Regex);
    expect(parts[2]).toBe('recording.wav');
  });

  it('generates unique keys for the same inputs', () => {
    const key1 = generateS3Key('user-1', 'file.mp3');
    const key2 = generateS3Key('user-1', 'file.mp3');
    expect(key1).not.toBe(key2);
  });
});
