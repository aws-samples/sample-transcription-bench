import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { MODEL_CATALOG } from '../shared/model-catalog';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

export const handler = async (
  _event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(MODEL_CATALOG),
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'CATALOG_ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }));

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'InternalError',
        message: 'An unexpected error occurred',
      }),
    };
  }
};
