import { CfnUserPoolUser, UserPool } from 'aws-cdk-lib/aws-cognito';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * Props for the {@link TestUser} construct.
 *
 * The construct provisions a single deploy-time test user in the supplied
 * User Pool. Email and password are class constants and are not
 * configurable.
 */
export interface TestUserProps {
  /** The Cognito User Pool to provision the test user in. */
  userPool: UserPool;
}

/**
 * Hard-coded email of the deploy-time test user. Surfaced verbatim as the
 * `TestUserEmail` stack output.
 */
const TEST_USER_EMAIL = 'john.doe@example.com';

/**
 * Hard-coded permanent password of the deploy-time test user. Surfaced
 * verbatim as the `TestUserPassword` stack output.
 *
 * Satisfies the User Pool's password policy (minLength 12, lower, upper,
 * digit, symbol).
 */
const TEST_USER_PASSWORD = 'Test123!Demo';

/**
 * Deploy-time test user construct.
 *
 * Provisions one Cognito user with email `john.doe@example.com` and the
 * permanent password `Test123!Demo`. The user is created via
 * `CfnUserPoolUser` (with `email_verified=true` and `MessageAction=SUPPRESS`
 * so no welcome email is sent) and immediately confirmed by an
 * `AwsCustomResource` that calls `AdminSetUserPassword(Permanent=true)`
 * on Create and Update.
 *
 * Idempotency: the underlying SDK call (`adminSetUserPassword`) is itself
 * idempotent and the custom resource carries a stable physical id keyed
 * on `${userPoolId}:${email}`, so re-deploys leave the password unchanged.
 *
 * Cleanup: there is no `onDelete` block. The User Pool is configured with
 * `removalPolicy=DESTROY`, so `cdk destroy` removes the pool and the user
 * with it.
 */
export class TestUser extends Construct {
  /** The hard-coded email of the deploy-time test user. */
  public readonly email: string = TEST_USER_EMAIL;

  /** The hard-coded permanent password of the deploy-time test user. */
  public readonly password: string = TEST_USER_PASSWORD;

  constructor(scope: Construct, id: string, props: TestUserProps) {
    super(scope, id);

    const cfnUser = new CfnUserPoolUser(this, 'CfnUser', {
      userPoolId: props.userPool.userPoolId,
      username: TEST_USER_EMAIL,
      messageAction: 'SUPPRESS',
      userAttributes: [
        { name: 'email', value: TEST_USER_EMAIL },
        { name: 'email_verified', value: 'true' },
      ],
    });

    const adminSetPasswordCall = {
      service: 'CognitoIdentityServiceProvider',
      action: 'adminSetUserPassword',
      parameters: {
        UserPoolId: props.userPool.userPoolId,
        Username: TEST_USER_EMAIL,
        Password: TEST_USER_PASSWORD,
        Permanent: true,
      },
      physicalResourceId: PhysicalResourceId.of(
        `${props.userPool.userPoolId}:${TEST_USER_EMAIL}`,
      ),
    };

    const setPwd = new AwsCustomResource(this, 'SetPassword', {
      resourceType: 'Custom::TestUserPassword',
      onCreate: adminSetPasswordCall,
      onUpdate: adminSetPasswordCall,
      // No onDelete: the User Pool's removalPolicy=DESTROY removes the
      // user transitively when the stack is torn down.
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ['cognito-idp:AdminSetUserPassword'],
          resources: [props.userPool.userPoolArn],
        }),
      ]),
    });

    // Ensure the password is set only after the user exists.
    setPwd.node.addDependency(cfnUser);
  }
}
