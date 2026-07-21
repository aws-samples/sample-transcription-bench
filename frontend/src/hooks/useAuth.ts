import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
  createElement,
} from 'react';
import {
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  getCurrentUser as amplifyGetCurrentUser,
  fetchAuthSession,
} from 'aws-amplify/auth';

interface AuthUser {
  userId: string;
  username: string;
  displayName: string;
}

/**
 * Result of an attempted sign-in. Three variants only:
 * - `success`     — Cognito returned `nextStep.signInStep === 'DONE'`.
 * - `authError`   — Cognito rejected the credentials (NotAuthorized / UserNotFound).
 * - `serviceError` — network failure, unexpected service response, or any other
 *                    error that is not an authentication error.
 *
 * There is intentionally no `newPasswordRequired` variant: the deploy-time
 * test user has a permanent password, and any user the deployer creates via
 * the Cognito console can be created with `Permanent=true` from the console.
 */
export type SignInResult =
  | { kind: 'success' }
  | { kind: 'authError'; message: string }
  | { kind: 'serviceError'; message: string };

export interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  /** Returns the Cognito ID token (JWT string), or `null` when no session. */
  getJwtToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Cognito error names that represent "the credentials were rejected" rather
 * than "the service is unreachable / something else went wrong". These are
 * surfaced to the user verbatim because they are the messages Cognito itself
 * produces (e.g. "Incorrect username or password.").
 */
const AUTH_ERROR_NAMES: ReadonlySet<string> = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
]);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadCurrentUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const currentUser = await amplifyGetCurrentUser();
      const session = await fetchAuthSession();
      const payload = session.tokens?.idToken?.payload;
      const email = payload?.email as string | undefined;
      return {
        userId: currentUser.userId,
        username: currentUser.username,
        displayName: email || currentUser.username,
      };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const u = await loadCurrentUser();
      if (!cancelled) {
        setUser(u);
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCurrentUser]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      try {
        const result = await amplifySignIn({ username: email, password });
        const step = result.nextStep?.signInStep;
        if (step === 'DONE') {
          const u = await loadCurrentUser();
          setUser(u);
          return { kind: 'success' };
        }
        // Any other nextStep (including CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED)
        // is unreachable in practice for this app — the test user's password is
        // permanent. Surface it as a service error so the LoginPage tells the
        // user something useful instead of silently hanging.
        return {
          kind: 'serviceError',
          message: `Unexpected sign-in challenge: ${step ?? 'unknown'}`,
        };
      } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        const rawMessage =
          err instanceof Error && err.message ? err.message : String(err);

        if (AUTH_ERROR_NAMES.has(name)) {
          return { kind: 'authError', message: rawMessage };
        }
        return {
          kind: 'serviceError',
          message: `Network or service error during sign-in: ${rawMessage}`,
        };
      }
    },
    [loadCurrentUser],
  );

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  const getJwtToken = useCallback(async (): Promise<string | null> => {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() ?? null;
    } catch {
      return null;
    }
  }, []);

  const value: AuthContextValue = {
    isAuthenticated: !!user,
    isLoading,
    user,
    signIn,
    signOut,
    getJwtToken,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
