import { ModelInfo } from './types';

// SageMaker hourly instance rates sourced from AWS Cost Explorer (us-west-2),
// matching the line items shown under "Amazon SageMaker RunInstance" in the
// AWS console. Update these if you change region or instance type.
const SAGEMAKER_G6_XLARGE_HOURLY_USD = 1.1267;   // ml.g6.xlarge in us-west-2

export const MODEL_CATALOG: ModelInfo[] = [
  {
    modelId: 'bedrock-voxtral-mini',
    modelName: 'Mistral Voxtral Mini 3B',
    provider: 'bedrock',
    supportedFormats: ['audio/wav'],
    inputCostPer1kTokens: 0.04,
    outputCostPer1kTokens: 0.04,
    description: 'Mistral Voxtral Mini 3B speech-to-text via Bedrock',
  },
  {
    modelId: 'bedrock-voxtral-small',
    modelName: 'Mistral Voxtral Small 24B',
    provider: 'bedrock',
    supportedFormats: ['audio/wav'],
    inputCostPer1kTokens: 0.10,
    outputCostPer1kTokens: 0.30,
    description: 'Mistral Voxtral Small 24B speech-to-text via Bedrock',
  },
  {
    // modelId is kept as `sagemaker-whisper-large-v3` for backwards
    // compatibility with existing job records and the CDK endpoint
    // construct name. The served model is now the distilled variant.
    modelId: 'sagemaker-whisper-large-v3',
    modelName: 'Distil-Whisper Large v3',
    provider: 'sagemaker',
    supportedFormats: ['audio/wav'],
    instanceType: 'ml.g6.xlarge',
    instanceHourlyRateUsd: SAGEMAKER_G6_XLARGE_HOURLY_USD,
    // Best-case per-minute at 100% endpoint utilization. Real cost is
    // instance-hours and accrues whether or not the endpoint is invoked.
    costPerMinute: parseFloat((SAGEMAKER_G6_XLARGE_HOURLY_USD / 60).toFixed(4)),
    description:
      'Distil-Whisper Large v3 (English-only, ~6x faster than Whisper Large v3) on SageMaker GPU endpoint',
  },
  {
    modelId: 'sagemaker-qwen-asr',
    modelName: 'Qwen3 ASR 0.6B',
    provider: 'sagemaker',
    supportedFormats: ['audio/wav'],
    instanceType: 'ml.g6.xlarge',
    instanceHourlyRateUsd: SAGEMAKER_G6_XLARGE_HOURLY_USD,
    costPerMinute: parseFloat((SAGEMAKER_G6_XLARGE_HOURLY_USD / 60).toFixed(4)),
    description: 'Qwen3 ASR 0.6B speech-to-text on SageMaker GPU endpoint',
  },
  {
    modelId: 'sagemaker-parakeet-tdt-0.6b',
    modelName: 'NVIDIA Parakeet TDT 0.6B v3',
    provider: 'sagemaker',
    supportedFormats: ['audio/wav'],
    instanceType: 'ml.g6.xlarge',
    instanceHourlyRateUsd: SAGEMAKER_G6_XLARGE_HOURLY_USD,
    costPerMinute: parseFloat((SAGEMAKER_G6_XLARGE_HOURLY_USD / 60).toFixed(4)),
    description:
      'NVIDIA Parakeet TDT 0.6B v3 (NeMo, English ASR) on SageMaker GPU endpoint',
  },
  {
    modelId: 'transcribe-standard',
    modelName: 'AWS Transcribe Standard',
    provider: 'transcribe',
    supportedFormats: ['audio/wav'],
    // AWS Transcribe Standard tier 1 list price (first 250k min/month, us-west-2).
    costPerMinute: 0.024,
    description: 'AWS Transcribe managed service',
  },
];
