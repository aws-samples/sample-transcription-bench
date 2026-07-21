// Model Status
export type ModelStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR' | 'TIMED_OUT';

// Error code — must mirror backend/shared/errors.ts. The frontend switches on
// this to render a friendly headline; the raw SDK message lives in
// `errorDetails` and is shown in a "Show details" disclosure.
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

// Job Status
export type JobStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

// Evaluation Status
export type EvaluationStatus = 'PENDING' | 'COMPLETED' | 'ERROR' | 'SKIPPED';

// Benchmark Metrics
export interface BenchmarkMetrics {
  latencyMs: number;
  estimatedCostUsd: number;
}

// LLM-as-a-Judge result (score 0..100 + short rationale)
export interface LLMJudgeResult {
  score: number;
  rationale: string;
}

// Per-metric error message — populated only when one metric failed but others
// succeeded. Keeps partial evaluation results renderable.
export interface EvaluationErrors {
  wer?: string;
  mer?: string;
  semanticWer?: string;
  llmJudge?: string;
}

// Evaluation result for a single (job, model) pair
export interface ModelEvaluation {
  status: EvaluationStatus;
  wer?: number;          // 0..1 (lower better)
  mer?: number;          // 0..1 (lower better)
  /** Total high-value entities the judge identified in the ground truth. */
  merTotal?: number;
  /** Number of those entities the hypothesis missed. */
  merMissed?: number;
  semanticWer?: number;  // 0..1 (lower better)
  llmJudge?: LLMJudgeResult;
  errorMessage?: string;
  errors?: EvaluationErrors;
}

// Model Info — mirrors backend model catalog entry
export interface ModelInfo {
  modelId: string;
  modelName: string;
  provider: 'bedrock' | 'sagemaker' | 'transcribe';
  supportedFormats: string[];
  costPerMinute?: number;
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  // SageMaker-only — see backend/shared/types.ts for derivation notes.
  instanceType?: string;
  instanceHourlyRateUsd?: number;
  description: string;
}

// Job Summary — returned in paginated job list
export interface JobSummary {
  jobId: string;
  status: JobStatus;
  modelIds: string[];
  createdAt: string;
  completedAt?: string;
}

// Model Result — individual model transcription result
export interface ModelResult {
  modelId: string;
  status: ModelStatus;
  transcriptionText?: string;
  /** Friendly user-facing summary. See `errorCode` for the category. */
  errorMessage?: string;
  /** Stable enum the UI switches on to render an error state. */
  errorCode?: ErrorCode;
  /** Original SDK / runtime message, surfaced behind a disclosure. */
  errorDetails?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
  completedAt?: string;
  evaluation?: ModelEvaluation;
}

// Job Detail Response — full job with results
export interface JobDetailResponse {
  jobId: string;
  userId: string;
  status: JobStatus;
  s3Key: string;
  audioUrl?: string;
  groundTruthText?: string;
  modelIds: string[];
  results: ModelResult[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// Upload Response — pre-signed URL for S3 direct upload
export interface UploadResponse {
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
}

// Sample Audio — pre-available audio file for quick testing
export interface SampleAudio {
  name: string;
  s3Key: string;
  sizeBytes: number;
  previewUrl: string;
}

// WebSocket Message — real-time updates from server
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
  evaluation?: ModelEvaluation;
  timestamp: string;
}
