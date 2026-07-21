import { RemovalPolicy } from 'aws-cdk-lib';
import {
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
} from 'aws-cdk-lib/aws-cognito';
import { Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Props for the {@link CognitoAuth} construct.
 *
 * The construct itself does not read CDK context; the caller (typically
 * `MainStack`) is responsible for resolving any context-driven values and
 * passing them in.
 */
export interface CognitoAuthProps {
  /**
   * Optional explicit User Pool name. When omitted, or when the value is an
   * empty/whitespace-only string, CDK auto-generates the User Pool name.
   */
  userPoolName?: string;
}

/**
 * Cognito authentication construct: provisions a User Pool, a User Pool
 * Client, and an Identity Pool with email/password sign-in only.
 *
 * No hosted UI domain, no external identity provider, no OAuth flows.
 */
export class CognitoAuth extends Construct {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly userPoolClientId: string;
  public readonly identityPoolId: string;

  constructor(scope: Construct, id: string, props: CognitoAuthProps = {}) {
    super(scope, id);

    // Treat empty / whitespace-only userPoolName as not supplied so CDK
    // auto-generates a name. (Req 5.6)
    const trimmedName = props.userPoolName?.trim();
    const userPoolName =
      trimmedName !== undefined && trimmedName.length > 0
        ? trimmedName
        : undefined;

    // --- User Pool ---
    // Self-registration is disabled: only admins can create users (via the
    // Cognito console or AdminCreateUser API). The LoginPage UI does not
    // expose a sign-up form, so there is no public sign-up path.
    this.userPool = new UserPool(this, 'UserPool', {
      ...(userPoolName !== undefined ? { userPoolName } : {}),
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      autoVerify: { email: true },
      passwordPolicy: {
        // AwsSolutions-COG8 — minimum length raised from 8 to 12.
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- User Pool Client (no OAuth, no hosted UI) ---
    this.userPoolClient = this.userPool.addClient('AppClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO,
      ],
    });
    this.userPoolClientId = this.userPoolClient.userPoolClientId;

    // --- Identity Pool ---
    const identityPool = new CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });
    this.identityPoolId = identityPool.ref;

    // --- IAM role for authenticated identities ---
    const authenticatedRole = new Role(this, 'AuthenticatedRole', {
      assumedBy: new WebIdentityPrincipal(
        'cognito-identity.amazonaws.com',
      ).withConditions({
        StringEquals: {
          'cognito-identity.amazonaws.com:aud': identityPool.ref,
        },
        'ForAnyValue:StringLike': {
          'cognito-identity.amazonaws.com:amr': 'authenticated',
        },
      }),
    });

    new CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    });
  }
}
