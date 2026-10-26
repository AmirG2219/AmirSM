import { edit } from './edit.mjs';
edit('server/src/ai/client.ts', [
  ["  user: string;\n  toolName: string;", "  user: string;\n  /** full user content blocks (text + image blocks); when set it replaces `user` */\n  userContent?: unknown[];\n  toolName: string;"],
  ["const messages: any[] = [{ role: 'user', content: o.user }];", "const messages: any[] = [{ role: 'user', content: o.userContent ?? o.user }];"],
]);
