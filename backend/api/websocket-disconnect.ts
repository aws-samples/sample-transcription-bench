import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { buildConnPK, buildConnSK } from '../shared/dynamodb';

const TABLE_NAME = process.env.TABLE_NAME ?? '';

let docClient: DynamoDBDocumentClient;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const connectionId = event.requestContext.connectionId!;
    const client = getDocClient();

    // Look up the reverse mapping to find the userId
    const lookup = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `CONNID#${connectionId}`,
          SK: 'META',
        },
      }),
    );

    if (lookup.Item) {
      const userId = lookup.Item.userId as string;

      // Delete the connection record
      await client.send(
        new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: buildConnPK(userId),
            SK: buildConnSK(connectionId),
          },
        }),
      );

      // Delete the reverse lookup record
      await client.send(
        new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: `CONNID#${connectionId}`,
            SK: 'META',
          },
        }),
      );

      console.log(JSON.stringify({
        event: 'WEBSOCKET_DISCONNECT',
        userId,
        connectionId,
        timestamp: new Date().toISOString(),
      }));
    } else {
      // No reverse mapping found — connection may have already expired via TTL
      console.log(JSON.stringify({
        event: 'WEBSOCKET_DISCONNECT_STALE',
        connectionId,
        message: 'No reverse mapping found, connection may have expired',
        timestamp: new Date().toISOString(),
      }));
    }

    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'WEBSOCKET_DISCONNECT_ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));

    return { statusCode: 500, body: 'Internal server error' };
  }
};
