# Evaluation Metrics

When a job is created with a ground-truth `.txt` file, TranscribeBench runs a separate `Evaluator` Lambda that scores each model's transcript against the reference. The `EvaluationCard` in the UI displays four metrics:

| Metric | Range | Lower is better? | What it tells you |
| --- | --- | --- | --- |
| WER | 0..1 | Yes | Word-level edit distance vs the reference, after normalization. |
| MER | 0..1 | Yes | Fraction of high-value reference entities (proper nouns, numbers, dates, domain terms) the model failed to capture. |
| Semantic WER | 0..1 | Yes | LLM-judged proportion of meaning lost or altered, immune to dialect / synonyms / abbreviations. |
| LLM-as-Judge | 0..100 | No (higher is better) | Overall transcription quality with a 1–2 sentence rationale. |

The methodology was inspired by the AssemblyAI guide [How to evaluate speech recognition models](https://www.assemblyai.com/blog/how-to-evaluate-speech-recognition-models). What follows is an honest accounting of what TranscribeBench implements vs what the article describes — read this before treating the numbers as benchmarks.

## How metrics are computed

WER runs locally inside the evaluator Lambda — no network calls. The other three each cost one Bedrock call to **Anthropic Claude Sonnet 4.6** (configurable via the `BEDROCK_JUDGE_MODEL_ID` env var on the evaluator). All four run in parallel via `Promise.all`; one metric failing does not block the others — the failure is recorded in `evaluation.errors[<metric>]` and the rest still report.

Source: `backend/workers/evaluator/handler.ts`, `backend/shared/wer.ts`.

---

## Coverage at a glance

| Metric | Coverage of the article's method | Reason |
| --- | --- | --- |
| WER | ~85% | Same algorithm; simpler normalizer than OpenAI Whisper Normalizer. |
| Semantic WER | ~50% | Same idea, but a single LLM rating per transcript rather than a population statistic. |
| MER | ~30% | Same definition; LLM-extracted entity set per call instead of a curated domain dictionary. |
| LLM-as-Judge | ~80% | Single-rater scoring per transcript rather than comparative win rates across many test items. |

---

## WER — `~85%` aligned

**Article says:** insertions + deletions + substitutions divided by total reference words, after normalization. Recommends the OpenAI Whisper Normalizer.

**What we do:** standard Wagner-Fischer edit distance on tokens, divided by reference token count, after normalization. Implemented in `backend/shared/wer.ts`.

**Faithful to the article**
- Algorithm matches exactly. Counts the same three error types via the same edit-distance computation.
- Normalization: lowercase, strip punctuation, expand a small fixed contraction set, collapse whitespace.

**Where it diverges**
- Our normalizer is ~50 lines of TS rather than the OpenAI Whisper Normalizer. We expand a fixed table of ~10 contractions (`won't → will not`, `'re → are`, etc.). The Whisper Normalizer also handles British/American spelling unification, number-to-words, abbreviations like "Mr.", written-out times, and a much larger contraction table. A transcript that says "Mister Smith arrived at twelve thirty" against a reference of "Mr. Smith arrived at 12:30" will score worse for us than for the article's recommended pipeline.
- We clamp WER to `[0, 1]`. The article uses raw WER which can exceed 1 if there are more inserted words than reference words. The clamp is a UI choice, not a methodology change — the underlying edit distance is unclamped.

**Net:** very close. For comparing two ASR models against the same ground truth this is fine — the bias cancels. Absolute WER values are not directly comparable to AssemblyAI's published benchmarks.

---

## Semantic WER — `~50%` aligned

**Article says:** "An LLM (like Claude Sonnet) receives both the AI transcript and the reference transcript. The LLM judges whether they convey the same meaning. The system calculates accuracy based on semantic equivalence, not word-for-word matching."

**What we do:** one Bedrock call to Claude Sonnet 4.6 asking for a single number `semanticWer ∈ [0, 1]` where 0 means meaning fully preserved and 1 means meaning completely lost.

**Faithful to the article**
- LLM-as-evaluator approach.
- Same model class (Claude Sonnet).
- Same intent: meaning preservation, immune to dialect / contractions / abbreviations / casing.

**Where it diverges**
- The article doesn't actually publish the methodology — "calculates accuracy based on semantic equivalence" is hand-wavy. They don't say whether it's binary judgment averaged across many test items, a continuous score, or a normalized error rate.
- We picked a continuous-score interpretation (the LLM returns a number directly). That is more useful for a per-job UI score, but it is a single LLM rating, not a population metric. With `temperature=0` the same input gives the same answer, but the metric's resolution is genuinely lower than WER — Claude tends to round to coarse buckets.
- We do not enable extended thinking on Sonnet 4.6.

**Net:** the spirit is right; the actual number is one model's opinion of overall semantic divergence rather than something statistically grounded. Treat it as a useful tiebreaker against WER, not a precise ratio.

---

## MER — `~30%` aligned

**Article says:** "It measures accuracy specifically on high-value words like drug names and dosages, proper nouns and company names, medical procedures and diagnoses, numbers, dates, and addresses, and domain-specific terminology."

**What we do:** one Bedrock call asks Claude to (a) extract high-value entities from the reference, (b) check each one against the hypothesis, (c) report `mer = missed / total`. The prompt explicitly excludes dialectal contractions, casing, punctuation, and filler words from the entity set. When `total === 0` the metric is forced to 0 in code.

**Faithful to the article**
- Definition of "high-value entity" matches almost word-for-word.
- Output meaning matches: fraction of high-value items missed.

**Where it diverges (this is the big one)**
- The article assumes a **predefined dictionary of domain entities** (their AssemblyAI Medical Mode is benchmarked against a curated drug-name and procedure list). They do not ask an LLM to identify entities at evaluation time.
- We have the LLM identify entities per call. Two consequences: (1) the entity set is non-deterministic across runs unless `temperature=0` (which we set), and (2) for short transcripts with one or two entities, a single mis-classification can swing MER between 0 and 1.
- AssemblyAI's published 4.97% Medical-Mode MER is computed across a corpus of clinical audio with curated entity lists. Our MER is computed per single audio file with a one-shot LLM-extracted entity set. The metrics share a name; they are not the same statistic.

**Net:** useful "did the model catch the proper nouns / numbers" signal, but the metric definition is approximate. Doing real MER the article way needs a domain-entity dictionary plus a test corpus. We have neither.

---

## LLM-as-a-Judge — `~80%` aligned

**Article says:** "Use a reasoning model (Claude Sonnet with extended thinking) as a judge. Present anonymized transcripts side-by-side, ask the LLM to evaluate which transcript is higher quality, calculate win rates across a sample of audio."

**What we do:** Claude Sonnet 4.6 returns a 0–100 score with a 1–2 sentence rationale per transcript.

**Faithful to the article**
- Same role (LLM as evaluator), same model class.
- Same use case: nuanced quality assessment beyond pure word-matching.

**Where it diverges**
- The article describes a **comparative** setup: two anonymized transcripts judged side-by-side, win rate aggregated. We score each transcript independently. This is actually what most product surfaces want ("how good is this one model's output"), but it is a different statistic.
- We do not anonymize. The model knows it is looking at hypothesis vs reference, so it may bias toward transcripts that look more reference-like.
- We do not enable extended thinking on Sonnet 4.6. The article calls it out for highest-confidence judgments.
- One judgment per transcript. The article implies sample sizes (multiple test items, win rates aggregated) for stable signals.

**Net:** the per-transcript score + rationale is a useful product feature, but it is a single LLM rating without ensembling, anonymization, or extended thinking. Directionally correct (good transcripts score higher than bad ones); absolute numbers are noisy.

---

## What we deliberately do not do

These are in the article but out of scope for TranscribeBench:

- **Truth File Corrector** — AssemblyAI's dashboard tool to clean obvious transcriber errors out of the ground truth before WER is computed. Worth considering as a future "GT lint" pass.
- **Streaming metrics** — Time to First Token (TTFT), Time to Complete Turn (TTCT), deletion rate. We benchmark async (pre-recorded) transcription only.
- **Multi-rater ensembles** and **anonymized comparative judging** for LLM-as-Judge.
- **Curated domain-entity dictionaries** for MER.
- **Test-corpus aggregation** — mean WER/MER across N audio files with confidence intervals. We score one job at a time.

## What that means for your numbers

The metrics in the EvaluationCard are a reasonable **single-job quality signal** — useful for "Whisper or Qwen on this clip?" comparisons. They are not equivalent to AssemblyAI's published WER/MER benchmarks, which are population statistics over curated corpora.

- For internal model comparison: trust the relative ordering more than the absolute values.
- For published benchmarks: harden the corpus and methodology first.
- For a real-time "how good is this transcript right now" surface: the four metrics together are fit for purpose.

## Reading the EvaluationCard

The card under each transcription panel shows:

- **WER / MER / Sem WER** as percentages, color-coded green (≤5%), amber (≤15%), red (>15%).
- **Judge** as a score / 100 with the same color tiers (≥85 green, ≥60 amber, else red).
- The judge's **rationale** is hidden by default — click "Show judge rationale" to expand.

If a metric failed for any reason (Bedrock throttling, JSON parse error, ground-truth fetch failure), the cell shows `—` and a tooltip with the underlying error. The other three metrics still report.

## Source

- Evaluator Lambda — `backend/workers/evaluator/handler.ts`
- Local WER — `backend/shared/wer.ts` (with `wer.test.ts`)
- CDK construct — `infra/lib/compute/evaluator.ts`
- Frontend card — `frontend/src/components/EvaluationCard.tsx`
- Schema — `EvaluationRecord` in `backend/shared/types.ts`
