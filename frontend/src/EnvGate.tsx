import React from 'react';

/**
 * The exhaustive list of frontend environment variables that must be set
 * (and non-empty after trimming) before the application is allowed to mount.
 *
 * Note: VITE_COGNITO_DOMAIN is intentionally not included — the open-source
 * deployment uses native Cognito email/password auth and does not depend on
 * a hosted UI domain.
 */
export const REQUIRED = [
  'VITE_API_ENDPOINT',
  'VITE_WS_ENDPOINT',
  'VITE_USER_POOL_ID',
  'VITE_USER_POOL_CLIENT_ID',
  'VITE_IDENTITY_POOL_ID',
  'VITE_AWS_REGION',
] as const;

export type RequiredEnvKey = (typeof REQUIRED)[number];

export type CheckEnvResult =
  | { ok: true }
  | { ok: false; missing: string[] };

/**
 * Inspect the supplied environment object (defaults to `import.meta.env`) and
 * report whether every required key is present and non-empty.
 *
 * A key is considered "missing" when its value is not a string, or when the
 * value's trimmed form is the empty string.
 */
export function checkEnv(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
): CheckEnvResult {
  const missing: string[] = [];
  for (const key of REQUIRED) {
    const v = env[key];
    if (typeof v !== 'string' || v.trim() === '') {
      missing.push(key);
    }
  }
  if (missing.length === 0) {
    return { ok: true };
  }
  return { ok: false, missing };
}

export interface StartupErrorViewProps {
  missing: string[];
}

/**
 * Renders a self-contained startup error screen listing every offending
 * environment variable. The frontend must not mount any other route while
 * this view is displayed.
 */
export function StartupErrorView({ missing }: StartupErrorViewProps): JSX.Element {
  const containerStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#0f172a',
    color: '#f1f5f9',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
    padding: '48px 24px',
    boxSizing: 'border-box',
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: 720,
    margin: '0 auto',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: 32,
  };

  const headingStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 24,
    color: '#f87171',
  };

  const codeStyle: React.CSSProperties = {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 4,
    padding: '2px 6px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  };

  const listStyle: React.CSSProperties = {
    margin: '16px 0',
    paddingLeft: 24,
    lineHeight: 1.7,
  };

  return (
    <div style={containerStyle} role="alert" aria-live="assertive">
      <div style={cardStyle}>
        <h1 style={headingStyle}>Frontend configuration error</h1>
        <p>
          The following required environment variable
          {missing.length === 1 ? ' is' : 's are'} missing or empty:
        </p>
        <ul style={listStyle}>
          {missing.map((name) => (
            <li key={name}>
              <code style={codeStyle}>{name}</code>
            </li>
          ))}
        </ul>
        <p>
          Populate <code style={codeStyle}>frontend/.env.production</code> with the
          values from the <code style={codeStyle}>cdk deploy</code> outputs and
          rebuild the frontend.
        </p>
      </div>
    </div>
  );
}
