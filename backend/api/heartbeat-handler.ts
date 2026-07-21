import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { WebSocketMessage } from '../shared/types';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT ?? '';

let docClient: DynamoDBDocumentClient;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

let apigwClient: ApiGatewayManagementApiClient;

function getApigwClient(): ApiGatewayManagementApiClient {
  if (!apigwClient) {
    apigwClient = new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_ENDPOINT });
  }
  return apigwClient;
}

/**
 * Heartbeat Lambda — invoked by CloudWatch Events rule every 30 seconds.
 * Scans DynamoDB for all active WebSocket connections and pings each one.
 * Deletes stale connections that return GoneException.
 */
export const handler = async (): Promise<void> => {
  console.log(JSON.stringify({
    event: 'HEARTBEAT_START',
    timestamp: new Date().toISOString(),
  }));

  const connections = await scanAllConnections();

  if (connections.length === 0) {
    console.log(JSON.stringify({
      event: 'HEARTBEAT_NO_CONNECTIONS',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  const heartbeatMessage: WebSocketMessage = {
    action: 'HEARTBEAT',
    jobId: '',
    timestamp: new Date().toISOString(),
  };

  const payload = Buffer.from(JSON.stringify(heartbeatMessage));
  const client = getApigwClient();

  let pinged = 0;
  let stale = 0;

  for (const conn of connections) {
    try {
      await client.send(
        new PostToConnectionCommand({
          ConnectionId: conn.connectionId,
          Data: payload,
        }),
      );
      pinged++;
    } catch (error: any) {
      if (error.name === 'GoneException' || error.statusCode === 410) {
        await deleteStaleConnection(conn.userId, conn.connectionId);
        stale++;
      } else {
        console.error(JSON.stringify({
          event: 'HEARTBEAT_PING_ERROR',
          connectionId: conn.connectionId,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }

  console.log(JSON.stringify({
    event: 'HEARTBEAT_COMPLETE',
    totalConnections: connections.length,
    pinged,
    staleDeleted: stale,
    timestamp: new Date().toISOString(),
  }));
};

interface ConnectionInfo {
  userId: string;
  connectionId: string;
}

/**
 * Scan the DynamoDB table for all connection records.
 * Connection records have PK beginning with "CONN#" and SK beginning with "CONN#".
 */
async function scanAllConnections(): Promise<ConnectionInfo[]> {
  const connections: ConnectionInfo[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await getDocClient().send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :pkPrefix) AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pkPrefix': 'CONN#',
          ':skPrefix': 'CONN#',
        },
        ProjectionExpression: 'userId, connectionId',
        ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );

    for (const item of result.Items ?? []) {
      connections.push({
        userId: item.userId as string,
        connectionId: item.connectionId as string,
      });
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return connections;
}

/**
 * Delete a stale connection record and its reverse lookup from DynamoDB.
 */
async function deleteStaleConnection(userId: string, connectionId: string): Promise<void> {
  const client = getDocClient();

  try {
    // Delete the connection record: PK=CONN#{userId}, SK=CONN#{connectionId}
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `CONN#${userId}`,
          SK: `CONN#${connectionId}`,
        },
      }),
    );

    // Delete the reverse lookup record: PK=CONNID#{connectionId}, SK=META
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
      event: 'HEARTBEAT_STALE_CONNECTION_DELETED',
      userId,
      connectionId,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'HEARTBEAT_STALE_CONNECTION_DELETE_ERROR',
      userId,
      connectionId,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));
  }
}
