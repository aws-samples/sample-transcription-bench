import { RemovalPolicy } from 'aws-cdk-lib';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
} from 'aws-cdk-lib/aws-s3';
import { AnyPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class AudioBucket extends Construct {
  public readonly bucket: Bucket;
  /**
   * Dedicated bucket capturing S3 server access logs for {@link bucket}.
   * Created to satisfy `AwsSolutions-S1` (server access logs enabled).
   */
  public readonly accessLogsBucket: Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // S3 doesn't permit a bucket to log to itself, so the logs sink is
    // a separate bucket. Encryption is AES256 because SSE-KMS isn't
    // supported as the destination for S3 server access logs.
    this.accessLogsBucket = new Bucket(this, 'AudioAccessLogs', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.bucket = new Bucket(this, 'AudioBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      // AwsSolutions-S10 — require TLS for all requests.
      enforceSSL: true,
      // AwsSolutions-S1  — server access logs to a dedicated bucket.
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'audio-bucket/',
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
    });

    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DenyPublicAccess',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: {
            'aws:PrincipalAccount': this.bucket.stack.account,
          },
        },
      })
    );
  }
}
