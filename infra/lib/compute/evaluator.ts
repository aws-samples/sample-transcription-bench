import { Duration } from 'aws-cdk-lib';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { createScopedLambdaRole } from './lambda-role';

export interface EvaluatorProps {
  table: Table;
  bucket: Bucket;
  /**
   * Bedrock model ID used for the LLM-driven metrics (MER, Semantic WER,
   * LLM-as-Judge). Defaults to Anthropic Claude Sonnet 4.6 on Bedrock.
   */
  judgeModelId?: string;
}

/**
 * Evaluator Lambda — DynamoDB Streams consumer (independent of websocket-push).
 *
 * Computes WER, MER, Semantic WER, and an LLM-as-Judge score whenever a
 * transcription RESULT row goes COMPLETED and the parent job has a ground
 * truth file. Writes results to a separate EVAL#{modelId} row so the
 * existing stream consumers are unaffected.
 */
export class Evaluator extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: EvaluatorProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'EvaluatorLogGroup', {
      retention: RetentionDays.ONE_MONTH,
    });

    // Custom execution role — see `lambda-role.ts` for rationale.
    const role = createScopedLambdaRole(this, 'ExecutionRole', logGroup);

    this.handler = new NodejsFunction(this, 'EvaluatorFunction', {
      runtime: Runtime.NODEJS_24_X,
      entry: 'backend/workers/evaluator/index.ts',
      handler: 'handler',
      // Bedrock judge calls run in parallel; allow comfortable headroom
      // for the slowest of the three to finish.
      timeout: Duration.minutes(2),
      memorySize: 512,
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        BEDROCK_JUDGE_MODEL_ID:
          props.judgeModelId ?? 'us.anthropic.claude-sonnet-4-6',
      },
      logGroup,
      role,
      bundling: {
        forceDockerBundling: false,
      },
    });

    // Stream consumer — same source as websocket-push, batchSize 1 to keep
    // per-record error isolation simple and avoid one bad record poisoning
    // a whole batch. Latest position so deploys don't replay history.
    this.handler.addEventSource(
      new DynamoEventSource(props.table, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 1,
      }),
    );

    // Read GT files; read parent job records; write EVAL rows.
    props.bucket.grantRead(this.handler);
    props.table.grantReadWriteData(this.handler);

    // Bedrock InvokeModel — wildcard resource (matches the existing bedrock-worker
    // construct). Tighten with a model-ARN list if a stricter policy is needed.
    this.handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );
  }
}
