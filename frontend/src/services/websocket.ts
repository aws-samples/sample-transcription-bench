const WS_URL = import.meta.env.VITE_WS_ENDPOINT ?? '';

export type MessageHandler = (data: unknown) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private openHandler: (() => void) | null = null;
  private messageHandler: MessageHandler | null = null;
  private closeHandler: (() => void) | null = null;

  connect(token: string): void {
    this.disconnect();
    const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.openHandler?.();
    };

    this.ws.onmessage = (event) => {
      if (this.messageHandler) {
        try {
          const data = JSON.parse(event.data as string);
          this.messageHandler(data);
        } catch {
          // ignore non-JSON messages
        }
      }
    };

    this.ws.onclose = () => {
      this.closeHandler?.();
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
