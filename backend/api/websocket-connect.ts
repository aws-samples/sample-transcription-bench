import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildConnPK, buildConnSK } from '../shared/dynamodb';

const TABLE_NAME = process.env.TABLE_NAME ?? '';

let docClient: DynamoDBDocumentClient;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

/**
 * Decode the payload section of a JWT to extract claims.
 * No signature verification — API Gateway / Cognito authorizer handles that.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const token = event.queryStringParameters?.token;
    if (!token) {
      return { statusCode: 401, body: 'Unauthorized: missing token' };
    }

    let userId: string;
    try {
      const claims = decodeJwtPayload(token);
      userId = claims.sub as string;
      if (!userId) {
        return { statusCode: 401, body: 'Unauthorized: missing sub claim' };
      }
    } catch {
      return { statusCode: 401, body: 'Unauthorized: invalid token' };
    }

    const connectionId = event.requestContext.connectionId!;
    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours

    const client = getDocClient();

    // Store connection record: PK=CONN#{userId}, SK=CONN#{connectionId}
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: buildConnPK(userId),
          SK: buildConnSK(connectionId),
          userId,
          connectionId,
          connectedAt: now,
          ttl,
        },
      }),
    );

    // Store reverse lookup: PK=CONNID#{connectionId}, SK=META
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `CONNID#${connectionId}`,
          SK: 'META',
          userId,
          connectionId,
          connectedAt: now,
          ttl,
        },
      }),
    );

    console.log(JSON.stringify({
      event: 'WEBSOCKET_CONNECT',
      userId,
      connectionId,
      timestamp: now,
    }));

    return { statusCode: 200, body: 'Connected' };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'WEBSOCKET_CONNECT_ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));

    return { statusCode: 500, body: 'Internal server error' };
  }
};
