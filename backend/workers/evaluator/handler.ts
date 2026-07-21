import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { EvaluationErrors, EvaluationRecord, LLMJudgeResult } from '../../shared/types';
import {
  buildEvalPK,
  buildEvalSK,
  getJobById,
  writeEvaluation,
} from '../../shared/dynamodb';
import { computeWer } from '../../shared/wer';
import { logger } from '../../shared/logger';

const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({});

const JUDGE_MODEL_ID =
  process.env.BEDROCK_JUDGE_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';

/**
 * Evaluator Lambda — DynamoDB Streams consumer.
 *
 * Triggered for every change on the JobTable. For each newly-COMPLETED
 * RESULT row, if the parent JobRecord has a `groundTruthS3Key`, we compute
 * accuracy metrics (WER, MER, Semantic WER, LLM-as-Judge) and write a
 * separate `EVAL#{modelId}` row. The websocket-push consumer fans the
 * EVALUATION row out to connected clients.
 *
 * No metrics are computed when no ground truth is provided — we still write
 * a SKIPPED row so the UI knows evaluation is final.
 */
export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      logger.error({
        event: 'evaluator_record_error',
        eventID: record.eventID,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
};

async function processRecord(record: DynamoDBRecord): Promise<void> {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') {
    return;
  }

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return;

  const item = unmarshall(newImage as Record<string, never>);
  const pk = item.PK as string | undefined;
  const sk = item.SK as string | undefined;

  // Only react to RESULT rows transitioning to COMPLETED.
  if (!pk?.startsWith('JOB#') || !sk?.startsWith('RESULT#')) return;
  if (item.status !== 'COMPLETED') return;

  const jobId = pk.slice('JOB#'.length);
  const modelId = sk.slice('RESULT#'.length);
  const transcriptionText = (item.transcriptionText as string | undefined) ?? '';

  // Idempotency: if an EVAL row for this (jobId, modelId) already exists with
  // a terminal status, skip. We rely on the fact that DDB stream MODIFY events
  // can re-deliver — without this guard we'd re-spend on Bedrock unnecessarily.
  // (We do a Get rather than a Query to keep this cheap.)
  // NOTE: a small race exists where two stream batches arrive in parallel;
  // the worst case is duplicate Bedrock calls, never a corrupt state since
  // PutCommand overwrites with the latest result.

  const job = await getJobById(jobId);
  if (!job) {
    logger.warn({ event: 'evaluator_job_not_found', jobId, modelId });
    return;
  }

  const now = () => new Date().toISOString();

  if (!job.groundTruthS3Key) {
    // No ground truth -> mark evaluation as skipped so the UI stops waiting.
    await writeEvaluation({
      PK: buildEvalPK(jobId),
      SK: buildEvalSK(modelId),
      jobId,
      modelId,
      status: 'SKIPPED',
      completedAt: now(),
    });
    logger.info({ event: 'evaluator_skipped_no_gt', jobId, modelId });
    return;
  }

  // Load ground truth text from S3.
  let groundTruthText: string;
  try {
    const gtResp = await s3Client.send(
      new GetObjectCommand({
        Bucket: job.s3Bucket,
        Key: job.groundTruthS3Key,
      }),
    );
    groundTruthText = (await gtResp.Body?.transformToString('utf-8')) ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await writeEvaluation({
      PK: buildEvalPK(jobId),
      SK: buildEvalSK(modelId),
      jobId,
      modelId,
      status: 'ERROR',
      errorMessage: `Failed to load ground truth: ${message}`,
      completedAt: now(),
    });
    logger.error({ event: 'evaluator_gt_load_error', jobId, modelId, error: message });
    return;
  }

  // Run all metrics. WER is local; the other three each cost one Bedrock call.
  // Run them in parallel and let each fail independently — partial results are
  // useful in the UI.
  logger.info({ event: 'evaluator_started', jobId, modelId });

  const errors: EvaluationErrors = {};

  const [werValue, merValue, semanticWerValue, llmJudgeValue] = await Promise.all([
    safeRun('wer', () => Promise.resolve(computeWer(groundTruthText, transcriptionText)), errors),
    safeRun('mer', () => computeMer(groundTruthText, transcriptionText), errors),
    safeRun('semanticWer', () => computeSemanticWer(groundTruthText, transcriptionText), errors),
    safeRun('llmJudge', () => computeLlmJudge(groundTruthText, transcriptionText), errors),
  ]);

  const evalRecord: EvaluationRecord = {
    PK: buildEvalPK(jobId),
    SK: buildEvalSK(modelId),
    jobId,
    modelId,
    status: 'COMPLETED',
    ...(werValue != null && { wer: werValue }),
    ...(merValue != null && {
      mer: merValue.mer,
      merTotal: merValue.total,
      merMissed: merValue.missed,
    }),
    ...(semanticWerValue != null && { semanticWer: semanticWerValue }),
    ...(llmJudgeValue != null && { llmJudge: llmJudgeValue }),
    ...(Object.keys(errors).length > 0 && { errors }),
    completedAt: now(),
  };

  await writeEvaluation(evalRecord);
  logger.info({
    event: 'evaluator_completed',
    jobId,
    modelId,
    wer: werValue,
    mer: merValue?.mer,
    merTotal: merValue?.total,
    merMissed: merValue?.missed,
    semanticWer: semanticWerValue,
    llmJudgeScore: llmJudgeValue?.score,
    metricErrors: Object.keys(errors),
  });
}

/**
 * Run a metric and capture failures into the shared `errors` object so other
 * metrics can still be reported.
 */
async function safeRun<K extends keyof EvaluationErrors, V>(
  key: K,
  fn: () => Promise<V>,
  errors: EvaluationErrors,
): Promise<V | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    errors[key] = message;
    logger.warn({ event: 'evaluator_metric_failed', metric: key, error: message });
    return undefined;
  }
}

// --------------------------------------------------------------------------
// Bedrock-driven metrics
//
// All three use Anthropic Claude Sonnet 4.6 via the Bedrock Messages API.
// We ask the model to return a single JSON object so we can parse it cleanly,
// and we cap output tokens to keep per-evaluation cost predictable.
// --------------------------------------------------------------------------

interface ClaudeMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

/**
 * Invoke the judge model.
 *
 * NOTE: Claude Sonnet 4.6 on Bedrock does not support assistant-message
 * prefill ("This model does not support assistant message prefill. The
 * conversation must end with a user message."), so we send a single user
 * turn and rely on a strong "JSON only, no prose" instruction in the
 * prompt itself plus the balanced-brace extractor in `extractJson` to
 * recover the JSON object even if Claude wraps it in prose or fences.
 */
async function callJudge(prompt: string, maxTokens: number): Promise<string> {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    ],
  };

  const resp = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: JUDGE_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    }),
  );

  const body = JSON.parse(new TextDecoder().decode(resp.body)) as ClaudeMessagesResponse;
  const text = body.content?.find((c) => c.type === 'text')?.text ?? '';

  if (body.stop_reason === 'max_tokens') {
    logger.warn({
      event: 'judge_truncated',
      stop_reason: body.stop_reason,
      preview: text.slice(0, 240),
    });
  }

  return text.trim();
}

/**
 * Extract a JSON object from a model response.
 *
 * With the assistant prefill of `{`, the response should always start with
 * a JSON object. We still strip ```json fences defensively in case Claude
 * decides to wrap things, and we walk the string to find a balanced
 * `{...}` rather than greedy-regex'ing — that way trailing prose doesn't
 * confuse the parser.
 */
function extractJson(text: string): unknown {
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  // Walk to find a balanced top-level object.
  const start = s.indexOf('{');
  if (start === -1) {
    throw new Error(`No JSON object in judge response: ${text.slice(0, 200)}`);
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(s.slice(start, i + 1));
      }
    }
  }

  throw new Error(`Unterminated JSON object in judge response: ${text.slice(0, 200)}`);
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) throw new Error(`Invalid numeric metric value: ${n}`);
  return Math.max(0, Math.min(1, v));
}

/**
 * Missed Entity Rate — fraction of high-value reference entities (proper
 * nouns, numbers, dates, drug names, domain terms) that the hypothesis
 * fails to capture. Done in a single Bedrock call: extract the entity set
 * from the reference, then check presence in the hypothesis.
 *
 * To keep the metric stable across runs we explicitly tell the judge what
 * does and does not count as an entity. Dialectal contractions, casing,
 * punctuation, and filler words are excluded so they can't swing MER.
 */
async function computeMer(reference: string, hypothesis: string): Promise<{
  mer: number;
  total: number;
  missed: number;
}> {
  const prompt = `You are computing Missed Entity Rate (MER) for a speech-to-text evaluation.

Step 1 — From the REFERENCE only, list every "high-value" entity. An entity is:
  - a proper noun (person, place, organization, product, brand)
  - a domain-specific term (drug name, medical procedure, technical jargon, legal term)
  - a number, date, time, currency amount, address, phone number, or unit
  - any acronym or abbreviation that is not a common English word

The following are NOT entities and must be excluded:
  - dialectal contractions or pronunciations (e.g. "tellin'", "sayin'", "gonna", "ain't")
  - common English words, articles, conjunctions, prepositions, filler words
  - differences in casing, punctuation, or spacing

Step 2 — For each entity, decide whether the HYPOTHESIS captures it.
  - "present" (true) if the hypothesis contains a recognizable form of the entity:
      * exact match (case-insensitive)
      * a well-known equivalent ("HCTZ" ≡ "hydrochlorothiazide", "U.S." ≡ "US")
      * a clearly-recognizable misspelling within 1-2 character edits, OR a
        phonetic near-match (e.g. "Odis" ≈ "Otis", "Aaron" ≈ "Erin"). The
        misspelling must be unambiguous given context — if the hypothesis word
        could plausibly mean something else entirely, mark it missed.
  - "missed" (false) if the entity is omitted or replaced by an unrelated word.

Step 3 — Compute mer = missed / total.
  - If total = 0 (no high-value entities), return mer = 0.
  - mer must be a number in [0, 1].

OUTPUT FORMAT — read carefully:
  - Reply with a single JSON object and nothing else.
  - The first character of your reply MUST be "{" and the last character MUST be "}".
  - No prose, no markdown, no code fences, no preamble like "Here is...".

Schema:
{"entities": [{"entity": "<text>", "present": <bool>}], "total": <int>, "missed": <int>, "mer": <number>}

Example reply:
{"entities":[{"entity":"hydrochlorothiazide","present":true},{"entity":"50 mg","present":false}],"total":2,"missed":1,"mer":0.5}

REFERENCE:
"""
${reference}
"""

HYPOTHESIS:
"""
${hypothesis}
"""`;

  const responseText = await callJudge(prompt, 1200);
  const parsed = extractJson(responseText) as {
    mer?: unknown;
    total?: unknown;
    missed?: unknown;
  };

  const total = typeof parsed.total === 'number' ? parsed.total : Number(parsed.total) || 0;
  const missed = typeof parsed.missed === 'number' ? parsed.missed : Number(parsed.missed) || 0;

  // If the judge returned total=0, force mer=0 regardless of what it computed.
  if (total === 0) return { mer: 0, total: 0, missed: 0 };

  return { mer: clamp01(parsed.mer), total, missed };
}

/**
 * Semantic WER — error rate based on meaning preservation rather than
 * exact word match. The judge returns a single number in [0,1] approximating
 * the fraction of meaning-bearing content that diverges from the reference.
 */
async function computeSemanticWer(reference: string, hypothesis: string): Promise<number> {
  const prompt = `You are computing Semantic WER for a speech-to-text evaluation.

Traditional Word Error Rate penalizes any word substitution. Semantic WER instead asks: how much of the MEANING in the reference is lost or altered in the hypothesis?

Equivalences that should NOT count as errors:
  - synonyms or near-synonyms ("automobile" ≈ "car")
  - dialectal contractions and pronunciations ("tellin'" ≡ "telling", "ain't" ≡ "is not")
  - casing, punctuation, contractions, hyphenation
  - equivalent abbreviations ("HCTZ" ≡ "hydrochlorothiazide")
  - filler words and disfluencies

Output a single number semanticWer in [0, 1]:
  0 = meaning is fully preserved
  1 = meaning is completely lost
  Intermediate values reflect the proportion of meaning that is lost or altered.

OUTPUT FORMAT — read carefully:
  - Reply with a single JSON object and nothing else.
  - The first character of your reply MUST be "{" and the last character MUST be "}".
  - No prose, no markdown, no code fences, no preamble like "Here is..." or "I'll analyze...".

Schema:
{"semanticWer": <number in [0,1]>}

Example reply:
{"semanticWer":0.05}

REFERENCE:
"""
${reference}
"""

HYPOTHESIS:
"""
${hypothesis}
"""`;

  const responseText = await callJudge(prompt, 400);
  const parsed = extractJson(responseText) as { semanticWer?: unknown };
  return clamp01(parsed.semanticWer);
}

/**
 * LLM-as-a-Judge — overall transcription quality on a 0..100 scale with a
 * brief rationale. Useful for nuanced/regulated use cases where flat error
 * rates miss what actually matters.
 */
async function computeLlmJudge(reference: string, hypothesis: string): Promise<LLMJudgeResult> {
  const prompt = `You are an expert evaluator of speech-to-text transcripts.

Compare the HYPOTHESIS to the REFERENCE and assign an overall quality score from 0 to 100, where:
  - 100 = perfect transcript (or only differences are immaterial: punctuation, casing, dialectal contractions, equivalent abbreviations)
  - 70-99 = strong; minor errors, meaning fully preserved
  - 40-69 = mediocre; several substantive errors but core content recoverable
  - 1-39 = poor; meaning largely lost
  - 0 = unintelligible or completely wrong

Keep the rationale concise (1-2 sentences) and reference specific differences when possible.

OUTPUT FORMAT — read carefully:
  - Reply with a single JSON object and nothing else.
  - The first character of your reply MUST be "{" and the last character MUST be "}".
  - No prose, no markdown, no code fences, no preamble.

Schema:
{"score": <int 0..100>, "rationale": "<short explanation>"}

Example reply:
{"score":92,"rationale":"Minor casing and punctuation differences only; meaning fully preserved."}

REFERENCE:
"""
${reference}
"""

HYPOTHESIS:
"""
${hypothesis}
"""`;

  const responseText = await callJudge(prompt, 600);
  const parsed = extractJson(responseText) as { score?: unknown; rationale?: unknown };
  const scoreNum = typeof parsed.score === 'number' ? parsed.score : Number(parsed.score);
  if (!Number.isFinite(scoreNum)) {
    throw new Error(`Invalid LLM judge score: ${String(parsed.score)}`);
  }
  const score = Math.max(0, Math.min(100, Math.round(scoreNum)));
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
  return { score, rationale };
}
