import { useRef, useState, useCallback, useEffect } from 'react';
import { WebSocketClient } from '../services/websocket';
import type { WebSocketMessage } from '../types';

const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

export function useWebSocket() {
  const clientRef = useRef(new WebSocketClient());
  const [messages, setMessages] = useState<WebSocketMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const retriesRef = useRef(0);
  const tokenRef = useRef<string | null>(null);
  const activeRef = useRef(false);

  const connect = useCallback((token: string) => {
    tokenRef.current = token;
    retriesRef.current = 0;
    activeRef.current = true;

    const client = clientRef.current;

    client.onOpen(() => {
      setIsConnected(true);
    });

    client.onMessage((data) => {
      setMessages((prev) => [...prev, data as WebSocketMessage]);
    });

    client.onClose(() => {
      setIsConnected(false);
      if (!activeRef.current) return;

      if (retriesRef.current < MAX_RETRIES) {
        const delay = BACKOFF_MS[retriesRef.current] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        retriesRef.current += 1;
        setTimeout(() => {
          if (activeRef.current && tokenRef.current) {
            client.connect(tokenRef.current);
          }
        }, delay);
      }
    });

    client.connect(token);
  }, []);

  const disconnect = useCallback(() => {
    activeRef.current = false;
    clientRef.current.disconnect();
    setIsConnected(false);
  }, []);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      clientRef.current.disconnect();
    };
  }, []);

  return { messages, isConnected, connect, disconnect };
}
