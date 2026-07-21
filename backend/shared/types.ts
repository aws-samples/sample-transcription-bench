import { ErrorCode } from './errors';

// Job Status
export type JobStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

// Model Status
export type ModelStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR' | 'TIMED_OUT';

// Evaluation Status — for the accuracy-metrics row written per (job, model)
export type EvaluationStatus = 'PENDING' | 'COMPLETED' | 'ERROR' | 'SKIPPED';

// Job Record (DynamoDB single-table: PK=USER#{userId}, SK=JOB#{jobId})
export interface JobRecord {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  jobId: string;
  userId: string;
  status: JobStatus;
  s3Key: string;
  s3Bucket: string;
  modelIds: string[];
  groundTruthS3Key?: string;  // S3 key for ground truth .txt file
  createdAt: string;       // ISO 8601
  startedAt?: string;
  completedAt?: string;
}

// Model Result Record (DynamoDB: PK=JOB#{jobId}, SK=RESULT#{modelId})
export interface ModelResultRecord {
  PK: string;
  SK: string;
  jobId: string;
  modelId: string;
  status: ModelStatus;
  transcriptionText?: string;
  /** Friendly, user-facing failure summary. See `errorCode` for the category. */
  errorMessage?: string;
  /** Stable enum the frontend switches on to render an error UI. */
  errorCode?: ErrorCode;
  /** Original SDK / runtime message, exposed in the UI behind a disclosure. */
  errorDetails?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
  completedAt?: string;
}

// LLM-as-Judge result — score (0..100) and short rationale
export interface LLMJudgeResult {
  score: number;
  rationale: string;
}

// Per-metric error message — written when a single metric fails so the others
// can still be reported to the client.
export interface EvaluationErrors {
  wer?: string;
  mer?: string;
  semanticWer?: string;
  llmJudge?: string;
}

// Evaluation Record (DynamoDB: PK=JOB#{jobId}, SK=EVAL#{modelId})
// Written by the evaluator Lambda whenever a transcription completes and the
// parent job has a `groundTruthS3Key`. Stored separately from RESULT rows so
// the existing websocket-push consumer is not affected by metric updates.
export interface EvaluationRecord {
  PK: string;
  SK: string;
  jobId: string;
  modelId: string;
  status: EvaluationStatus;
  // All metric fields are 0..1 unless noted (lower is better). Each may be
  // missing if that single metric failed but others succeeded — see `errors`.
  wer?: number;
  mer?: number;
  // Auditing companions for MER — total entities found in the GT and how many
  // were missed by the hypothesis. Surfaced in the UI so users can see the
  // denominator (e.g. "1/1 missed" reads very differently from "5/10 missed").
  merTotal?: number;
  merMissed?: number;
  semanticWer?: number;
  llmJudge?: LLMJudgeResult;
  errorMessage?: string;       // overall failure (e.g. could not load GT)
  errors?: EvaluationErrors;   // per-metric failures
  completedAt?: string;
}

// WebSocket Connection Record (DynamoDB: PK=CONN#{userId}, SK=CONN#{connectionId})
export interface ConnectionRecord {
  PK: string;
  SK: string;
  userId: string;
  connectionId: string;
  connectedAt: string;
  ttl: number;             // DynamoDB TTL (epoch seconds)
}

// Worker Event — input to each model-specific worker Lambda
export interface WorkerEvent {
  jobId: string;
  modelId: string;
  s3Key: string;
  s3Bucket: string;
}

// Benchmark Metrics — collected per transcription
export interface BenchmarkMetrics {
  latencyMs: number;
  estimatedCostUsd: number;
}

// Worker Result — output from each model-specific worker Lambda
export interface WorkerResult {
  jobId: string;
  modelId: string;
  status: 'COMPLETED' | 'ERROR' | 'TIMED_OUT';
  transcriptionText?: string;
  errorMessage?: string;
  errorCode?: ErrorCode;
  errorDetails?: string;
  metrics: BenchmarkMetrics;
}

// WebSocket Message — pushed to connected clients
export interface WebSocketMessage {
  action: 'RESULT' | 'JOB_COMPLETE' | 'EVALUATION' | 'HEARTBEAT';
  jobId: string;
  modelId?: string;
  transcriptionText?: string;
  status?: ModelStatus;
  errorMessage?: string;
  errorCode?: ErrorCode;
  errorDetails?: string;
  metrics?: BenchmarkMetrics;
  // Populated only when action === 'EVALUATION'
  evaluation?: {
    status: EvaluationStatus;
    wer?: number;
    mer?: number;
    merTotal?: number;
    merMissed?: number;
    semanticWer?: number;
    llmJudge?: LLMJudgeResult;
    errorMessage?: string;
    errors?: EvaluationErrors;
  };
  timestamp: string;
}

// Error Response — consistent API error format
export interface ErrorResponse {
  error: string;
  message: string;
  requestId?: string;
}

// Model Info — model catalog entry
export interface ModelInfo {
  modelId: string;
  modelName: string;
  provider: 'bedrock' | 'sagemaker' | 'transcribe';
  supportedFormats: string[];
  costPerMinute?: number;              // USD — used by sagemaker/transcribe
  inputCostPer1kTokens?: number;       // USD — used by bedrock token-based models
  outputCostPer1kTokens?: number;      // USD — used by bedrock token-based models
  // SageMaker-only — actual AWS billing dimension. costPerMinute for sagemaker
  // is derived as instanceHourlyRateUsd / 60 (best-case at 100% endpoint utilization).
  // Real cost is instance-hours, not minutes of audio.
  instanceType?: string;
  instanceHourlyRateUsd?: number;
  description: string;
}
