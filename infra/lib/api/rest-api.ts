import { Construct } from 'constructs';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  RestApi,
  CognitoUserPoolsAuthorizer,
  AuthorizationType,
  LambdaIntegration,
  MockIntegration,
  PassthroughBehavior,
  Cors,
  GatewayResponse,
  ResponseType,
  AccessLogFormat,
  LogGroupLogDestination,
  MethodLoggingLevel,
  RequestValidator,
} from 'aws-cdk-lib/aws-apigateway';

export interface RestApiGatewayProps {
  userPool: UserPool;
  uploadHandler: IFunction;
  orchestratorHandler: IFunction;
  jobsHandler: IFunction;
  catalogHandler: IFunction;
  samplesHandler: IFunction;
}

export class RestApiGateway extends Construct {
  public readonly api: RestApi;

  constructor(scope: Construct, id: string, props: RestApiGatewayProps) {
    super(scope, id);

    const accessLogs = new LogGroup(this, 'AccessLogs', {
      retention: RetentionDays.ONE_MONTH,
    });

    this.api = new RestApi(this, 'RestApi', {
      restApiName: 'TranscriptionComparisonApi',
      description: 'REST API for Audio Transcription Comparison Platform',
      // Stage-level logging (AwsSolutions-APIG1, APIG6).
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(accessLogs),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        loggingLevel: MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // AwsSolutions-APIG2 — request validator covers body and parameter
    // validation for all methods that opt in.
    new RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
    });

    // CORS headers on API Gateway error responses (authorizer rejections, etc.)
    new GatewayResponse(this, 'Default4xx', {
      restApi: this.api,
      type: ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
      },
    });

    new GatewayResponse(this, 'Default5xx', {
      restApi: this.api,
      type: ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
      },
    });

    // GET /health — Cognito auth, mock integration returning 200.
    // This endpoint is intentionally authenticated: it sits behind the same
    // Cognito user pool as the rest of the API so it cannot be used as an
    // unauthenticated reconnaissance surface (AwsSolutions-APIG4 / COG4).
    const health = this.api.root.addResource('health');
    health.addMethod(
      'GET',
      new MockIntegration({
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"status":"ok"}',
            },
          },
        ],
        passthroughBehavior: PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': '{"statusCode": 200}',
        },
      }),
      {
        methodResponses: [{ statusCode: '200' }],
        authorizer,
        authorizationType: AuthorizationType.COGNITO,
      }
    );

    // GET /models — Cognito auth, catalog Lambda
    const models = this.api.root.addResource('models');
    models.addMethod('GET', new LambdaIntegration(props.catalogHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    // GET /samples — Cognito auth, samples Lambda
    const samples = this.api.root.addResource('samples');
    samples.addMethod('GET', new LambdaIntegration(props.samplesHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    // POST /uploads — Cognito auth, upload Lambda
    const uploads = this.api.root.addResource('uploads');
    uploads.addMethod('POST', new LambdaIntegration(props.uploadHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    // /jobs resource
    const jobs = this.api.root.addResource('jobs');

    // POST /jobs — Cognito auth, orchestrator Lambda
    jobs.addMethod('POST', new LambdaIntegration(props.orchestratorHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    // GET /jobs — Cognito auth, jobs Lambda
    jobs.addMethod('GET', new LambdaIntegration(props.jobsHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    // GET /jobs/{jobId} — Cognito auth, jobs Lambda
    const jobById = jobs.addResource('{jobId}');
    jobById.addMethod('GET', new LambdaIntegration(props.jobsHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    // DELETE /jobs/{jobId} — Cognito auth, jobs Lambda
    jobById.addMethod('DELETE', new LambdaIntegration(props.jobsHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });
  }
}
