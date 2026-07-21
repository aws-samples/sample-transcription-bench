import React from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * MetricsGuidePage — a short, in-product reference for the metrics that show
 * up on each Comparison page. Covers latency, per-provider cost math (with a
 * region disclaimer for the hardcoded us-west-2 SageMaker rates), and the
 * four accuracy metrics.
 */
export default function MetricsGuidePage() {
  const navigate = useNavigate();

  return (
    <div style={s.container} className="animate-in">
      <button type="button" style={s.back} onClick={() => navigate(-1)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back
      </button>

      <header style={s.header}>
        <h1 style={s.title}>Metrics Guide</h1>
        <p style={s.subtitle}>
          What each number on a comparison means, how it's computed, and when to trust it.
        </p>
      </header>

      <Section title="Performance">
        <Metric
          name="Latency"
          unit="milliseconds"
          better="lower"
          summary="End-to-end wall-clock time inside the worker Lambda — from receiving the job to writing the result to DynamoDB."
        >
          <p style={s.body}>
            Includes model inference, network round-trips to AWS Transcribe / SageMaker / Bedrock, and any pre/post processing
            (presigning, JSON parsing). Excludes orchestrator queue time and WebSocket delivery, so it isn't quite "perceived"
            latency, but it's the right number for comparing models against each other.
          </p>
        </Metric>
      </Section>

      <Section title="Cost">
        <p style={s.body}>
          Cost is an <strong style={s.strong}>estimate per request</strong>, not actual AWS spend. Each provider bills
          differently — the worker Lambda multiplies the request by a rate from a shared model catalog and persists the
          result alongside the transcription.
        </p>

        <SubMetric
          name="Bedrock"
          summary="Token-based: inputCostPer1kTokens × inputTokens + outputCostPer1kTokens × outputTokens."
        >
          <p style={s.body}>
            Tokens come straight from the Bedrock Messages API <code style={s.code}>usage</code> field. This is real
            pay-per-call billing, so the displayed number tracks AWS spend closely.
          </p>
        </SubMetric>

        <SubMetric
          name="AWS Transcribe"
          summary="Per-minute: costPerMinute × estimatedDurationMinutes."
        >
          <p style={s.body}>
            Transcribe Standard tier 1 lists at <code style={s.code}>$0.024/min</code>. Duration is
            <em style={s.em}> estimated from file size</em> (~1.5 MB/min heuristic), not from actual audio metadata, so
            uncompressed WAV files overestimate the cost.
          </p>
        </SubMetric>

        <SubMetric
          name="SageMaker"
          summary="Per-minute attribution at 100% utilization: instanceHourlyRate / 60."
          warning
        >
          <p style={s.body}>
            SageMaker bills <strong style={s.strong}>per instance-hour</strong>, not per minute of audio. The endpoint accrues
            cost while it's running, regardless of whether you invoke it. The per-minute number shown here is the best-case
            floor (assuming 100% endpoint utilization). Real cost climbs sharply at lower utilization — at 10% utilization the
            effective rate is 10x what's displayed.
          </p>
          <p style={s.body}>
            On your AWS bill you'll see two SageMaker line items: <code style={s.code}>Invoke-Endpoint</code> (data in/out at
            $0.016/GB — usually rounds to zero) and <code style={s.code}>RunInstance</code> (the GPU instance-hours — this is
            the real cost).
          </p>
        </SubMetric>

        <Disclaimer>
          <strong style={s.strong}>Region disclaimer:</strong> SageMaker hourly rates and the Transcribe per-minute price are
          hardcoded for <code style={s.code}>us-west-2</code>. If you deploy this stack to another region, the displayed costs
          may not match your actual AWS bill — update the rates to match your target region. AWS Bedrock token pricing is
          uniform across most regions but worth verifying for your specific deployment.
        </Disclaimer>
      </Section>

      <Section
        title="Accuracy"
        subtitle="Only computed when a ground-truth .txt is uploaded with the audio. Each metric below is independent — one failing doesn't block the others."
      >
        <Metric
          name="WER"
          unit="0–100%"
          better="lower"
          summary="Word Error Rate: word-level edit distance vs the reference, after normalization."
        >
          <p style={s.body}>
            Standard Wagner-Fischer edit distance (insertions + deletions + substitutions) divided by reference word count.
            Normalization lowercases, strips punctuation, expands a small contraction set, and collapses whitespace. Computed
            locally — no LLM calls.
          </p>
          <p style={s.note}>
            Caveat: our normalizer is lighter than the OpenAI Whisper Normalizer. "Mister Smith arrived at twelve thirty" vs
            "Mr. Smith arrived at 12:30" will score worse here than under Whisper's normalizer. For relative model comparison
            the bias cancels.
          </p>
        </Metric>

        <Metric
          name="MER"
          unit="0–100%"
          better="lower"
          summary="Match Error Rate on high-value entities — proper nouns, numbers, dates, domain terms."
        >
          <p style={s.body}>
            One Bedrock call to Claude Sonnet 4.6 extracts the high-value entities from the reference, then checks each one
            against the hypothesis. Reported as <code style={s.code}>missed / total</code>. Excludes contractions, casing,
            punctuation, and filler words.
          </p>
          <p style={s.note}>
            Caveat: the entity set is LLM-extracted per call, not pulled from a curated domain dictionary. For short transcripts
            with one or two entities, a single mis-classification can swing the metric significantly.
          </p>
        </Metric>

        <Metric
          name="Semantic WER"
          unit="0–100%"
          better="lower"
          summary="LLM-judged proportion of meaning lost — immune to dialect, synonyms, and abbreviations."
        >
          <p style={s.body}>
            Claude Sonnet 4.6 returns a single number where 0 means meaning fully preserved and 1 means meaning completely lost.
            Useful as a tiebreaker against WER when two transcripts differ in wording but say the same thing.
          </p>
          <p style={s.note}>
            Caveat: it's one model's opinion, not a population statistic. The score has lower resolution than WER — Claude
            tends to round to coarse buckets.
          </p>
        </Metric>

        <Metric
          name="LLM-as-Judge"
          unit="0–100"
          better="higher"
          summary="Overall transcription quality score with a 1–2 sentence rationale."
        >
          <p style={s.body}>
            Claude Sonnet 4.6 grades the transcript end-to-end, factoring in fluency, fidelity, and obvious errors. Click
            "Show judge rationale" on the comparison page to expand the explanation.
          </p>
          <p style={s.note}>
            Caveat: per-transcript scoring without anonymization or extended thinking. Directionally correct (good transcripts
            score higher than bad ones); absolute numbers are noisy across runs.
          </p>
        </Metric>
      </Section>

      <Section title="What this isn't">
        <ul style={s.list}>
          <li style={s.listItem}>
            Real AWS spend. SageMaker cost in particular is a synthetic per-request attribution, not actual instance-hour
            billing.
          </li>
          <li style={s.listItem}>
            A published benchmark. AssemblyAI's WER/MER numbers are population statistics over curated corpora — these are
            single-job scores.
          </li>
          <li style={s.listItem}>
            Streaming-aware. We benchmark async (pre-recorded) transcription. No Time-to-First-Token or
            Time-to-Complete-Turn measurements.
          </li>
        </ul>
      </Section>
    </div>
  );
}

// --------------------------------------------------------------------------
// Layout primitives
// --------------------------------------------------------------------------

interface SectionProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

function Section({ title, subtitle, children }: SectionProps) {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>{title}</h2>
      {subtitle && <p style={s.sectionSubtitle}>{subtitle}</p>}
      <div style={s.sectionBody}>{children}</div>
    </section>
  );
}

interface MetricProps {
  name: string;
  unit: string;
  better: 'higher' | 'lower';
  summary: string;
  children: React.ReactNode;
}

function Metric({ name, unit, better, summary, children }: MetricProps) {
  return (
    <article style={s.card}>
      <div style={s.cardHeader}>
        <h3 style={s.cardTitle}>{name}</h3>
        <div style={s.cardMeta}>
          <span style={s.metaPill}>{unit}</span>
          <span style={{ ...s.metaPill, ...(better === 'lower' ? s.metaPillLower : s.metaPillHigher) }}>
            {better === 'lower' ? '↓ better' : '↑ better'}
          </span>
        </div>
      </div>
      <p style={s.summary}>{summary}</p>
      <div style={s.cardBody}>{children}</div>
    </article>
  );
}

interface SubMetricProps {
  name: string;
  summary: string;
  warning?: boolean;
  children: React.ReactNode;
}

function SubMetric({ name, summary, warning, children }: SubMetricProps) {
  return (
    <article style={{ ...s.card, ...(warning ? s.cardWarning : {}) }}>
      <div style={s.cardHeader}>
        <h3 style={s.cardTitle}>{name}</h3>
        {warning && <span style={s.warningPill}>important</span>}
      </div>
      <p style={s.summary}>{summary}</p>
      <div style={s.cardBody}>{children}</div>
    </article>
  );
}

function Disclaimer({ children }: { children: React.ReactNode }) {
  return (
    <div role="note" style={s.disclaimer}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={s.disclaimerIcon}
        aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div>{children}</div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Styles — match the rest of the app's dark-glass aesthetic
// --------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  container: { maxWidth: 880, margin: '0 auto', padding: '40px 24px 80px' },
  back: {
    display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
    color: '#818cf8', fontSize: 13, fontWeight: 500, cursor: 'pointer', padding: 0, marginBottom: 24,
  },
  header: { marginBottom: 36 },
  title: {
    margin: '0 0 8px', fontSize: 32, fontWeight: 600,
    color: 'rgba(255,255,255,0.95)', letterSpacing: '-0.03em',
  },
  subtitle: { margin: 0, fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 },

  section: { marginBottom: 40 },
  sectionTitle: {
    margin: '0 0 6px', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)',
    textTransform: 'uppercase' as const, letterSpacing: '0.08em',
  },
  sectionSubtitle: { margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 },
  sectionBody: { display: 'flex', flexDirection: 'column' as const, gap: 12 },

  card: {
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 14,
    background: 'rgba(0, 0, 0, 0.25)',
    padding: '18px 22px',
  },
  cardWarning: {
    borderColor: 'rgba(251,191,36,0.18)',
    background: 'rgba(251,191,36,0.04)',
  },
  cardHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, marginBottom: 8, flexWrap: 'wrap' as const,
  },
  cardTitle: {
    margin: 0, fontSize: 16, fontWeight: 600,
    color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.01em',
  },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 6 },
  metaPill: {
    fontSize: 10, fontWeight: 500, letterSpacing: '0.04em',
    padding: '3px 8px', borderRadius: 6,
    background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)',
    border: '1px solid rgba(255,255,255,0.05)',
    textTransform: 'uppercase' as const,
  },
  metaPillLower: { background: 'rgba(99,102,241,0.08)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.15)' },
  metaPillHigher: { background: 'rgba(52,211,153,0.08)', color: '#34d399', border: '1px solid rgba(52,211,153,0.15)' },
  warningPill: {
    fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
    padding: '3px 8px', borderRadius: 6,
    background: 'rgba(251,191,36,0.1)', color: '#fbbf24',
    textTransform: 'uppercase' as const,
  },
  summary: {
    margin: '0 0 10px', fontSize: 13, color: 'rgba(255,255,255,0.7)',
    lineHeight: 1.6, fontWeight: 500,
  },
  cardBody: { display: 'flex', flexDirection: 'column' as const, gap: 8 },

  body: { margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.7 },
  note: { margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.35)', lineHeight: 1.6, fontStyle: 'italic' as const },
  strong: { color: 'rgba(255,255,255,0.85)', fontWeight: 600 },
  em: { color: 'rgba(255,255,255,0.65)', fontStyle: 'italic' as const },
  code: {
    fontFamily: '"SF Mono", Menlo, monospace',
    fontSize: 12,
    padding: '1px 5px',
    borderRadius: 4,
    background: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.75)',
  },

  list: {
    margin: 0, paddingLeft: 18,
    display: 'flex', flexDirection: 'column' as const, gap: 6,
  },
  listItem: { fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.7 },

  disclaimer: {
    display: 'flex', gap: 12, alignItems: 'flex-start',
    padding: '14px 16px',
    border: '1px solid rgba(251,191,36,0.18)',
    borderRadius: 12,
    background: 'rgba(251,191,36,0.05)',
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13, lineHeight: 1.65,
    marginTop: 4,
  },
  disclaimerIcon: { color: '#fbbf24', flexShrink: 0, marginTop: 2 },
};
