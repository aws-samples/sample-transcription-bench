import { Construct } from 'constructs';
import { Stack } from 'aws-cdk-lib';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { CfnApi, CfnRoute, CfnIntegration, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';

export interface WebSocketApiProps {
  connectHandler: IFunction;
  disconnectHandler: IFunction;
}

export class WebSocketApi extends Construct {
  public readonly api: CfnApi;
  public readonly stage: CfnStage;
  /** The callback URL for posting messages back to connected clients via API Gateway Management API */
  public readonly callbackUrl: string;
  /** The WebSocket endpoint URL clients connect to */
  public readonly webSocketUrl: string;

  constructor(scope: Construct, id: string, props: WebSocketApiProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const stageName = 'prod';

    // WebSocket API
    this.api = new CfnApi(this, 'WebSocketApi', {
      name: 'TranscriptionComparisonWebSocketApi',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
      description: 'WebSocket API for real-time transcription result streaming',
    });

    // $connect integration
    const connectIntegration = new CfnIntegration(this, 'ConnectIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${props.connectHandler.functionArn}/invocations`,
    });

    // $disconnect integration
    const disconnectIntegration = new CfnIntegration(this, 'DisconnectIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${props.disconnectHandler.functionArn}/invocations`,
    });

    // $connect route — JWT validation is handled by the connect Lambda itself
    const connectRoute = new CfnRoute(this, 'ConnectRoute', {
      apiId: this.api.ref,
      routeKey: '$connect',
      target: `integrations/${connectIntegration.ref}`,
    });

    // $disconnect route
    const disconnectRoute = new CfnRoute(this, 'DisconnectRoute', {
      apiId: this.api.ref,
      routeKey: '$disconnect',
      target: `integrations/${disconnectIntegration.ref}`,
    });

    // Deployment is managed by `autoDeploy: true` on the stage below.
    // Setting both `deploymentId` and `autoDeploy` is rejected by API
    // Gateway on stack updates with:
    //   "Deployment ID cannot be set on this stage because AutoDeploy is enabled."
    // The stage carries explicit dependencies on the routes so that initial
    // creation order remains correct.

    // Stage with auto-deploy + access logging to a dedicated CloudWatch
    // log group (AwsSolutions-APIG1).
    const accessLogs = new LogGroup(this, 'AccessLogs', {
      retention: RetentionDays.ONE_MONTH,
    });

    this.stage = new CfnStage(this, 'ProdStage', {
      apiId: this.api.ref,
      stageName,
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: accessLogs.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          routeKey: '$context.routeKey',
          status: '$context.status',
          connectionId: '$context.connectionId',
          eventType: '$context.eventType',
        }),
      },
    });
    this.stage.addDependency(connectRoute);
    this.stage.addDependency(disconnectRoute);

    // Grant API Gateway permission to invoke the Lambda handlers
    props.connectHandler.addPermission('AllowWebSocketConnect', {
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${region}:${account}:${this.api.ref}/*/$connect`,
    });

    props.disconnectHandler.addPermission('AllowWebSocketDisconnect', {
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${region}:${account}:${this.api.ref}/*/$disconnect`,
    });

    // Callback URL for posting messages back to clients (used by push Lambda)
    this.callbackUrl = `https://${this.api.ref}.execute-api.${region}.amazonaws.com/${stageName}`;

    // WebSocket endpoint URL for client connections
    this.webSocketUrl = `wss://${this.api.ref}.execute-api.${region}.amazonaws.com/${stageName}`;
  }
}
