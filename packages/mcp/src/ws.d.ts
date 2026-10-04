// Minimal typing for the `ws` fallback (no @types/ws installed).
declare module "ws" {
  export const WebSocket: any;
}
