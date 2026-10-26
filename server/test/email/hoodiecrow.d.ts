declare module 'hoodiecrow-imap' {
  interface HoodiecrowServer {
    listen(port: number, host: string, cb: () => void): void;
    address(): { port: number };
    close(cb?: () => void): void;
  }
  export default function hoodiecrow(options?: Record<string, unknown>): HoodiecrowServer;
}
