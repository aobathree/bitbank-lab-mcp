import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express-serve-static-core';
import { createBearerAuthMiddleware, createMcpRateLimiter, requireMcpHttpToken } from '../lib/mcp-http-security.js';

const PORT = Number(process.env.PORT ?? 8787);
const ENDPOINT = '/mcp';

// HTTP transport は必ず Bearer トークンを要求する（未設定なら起動を拒否）。
// stdio transport (src/server.ts のデフォルト経路) はこのファイルを import しないため影響なし。
const MCP_HTTP_TOKEN = requireMcpHttpToken();

const app = express();
app.use(express.json({ limit: '2mb' }));

// ngrok Free のブラウザ警告回避用ヘッダ
app.use((_req: Request, res: Response, next: NextFunction) => {
	res.setHeader('ngrok-skip-browser-warning', '1');
	next();
});

// 簡易ヘルスチェック（認証・rate limit 対象外。意図的に /mcp とは別パスにしている）
app.get('/health', (_req: Request, res: Response) => {
	res.json({ ok: true, ts: Date.now() });
});

// /mcp 配下は rate limit → Bearer 認証の順で保護する（GET メタデータも含む）。
// rate limit を auth より先に置くのは、未認証クライアントによる総当たりや
// DoS でハンドラ層 (Private API も含む) を消耗させないため。
app.use(ENDPOINT, createMcpRateLimiter());
app.use(ENDPOINT, createBearerAuthMiddleware(MCP_HTTP_TOKEN));

// 最低限の /mcp ルート（メタ確認用）
app.get(ENDPOINT, (_req: Request, res: Response) => {
	res.json({
		version: '1.0',
		actions: [
			{
				name: 'ping',
				description: 'Health check action',
				parameters: { type: 'object', properties: { message: { type: 'string', description: 'Any message' } } },
			},
		],
	});
});

// 最小サーバ（必要に応じて既存の登録ロジックに差し替え可）
const server = new McpServer({ name: 'bb-mcp', version: '1.0.0' });
// SDK の registerTool 型が厳密すぎるため、空スキーマ登録にキャストを集約
(server as unknown as { registerTool: (n: string, s: unknown, h: unknown) => void }).registerTool(
	'ping',
	{
		description: 'Return a ping response',
		inputSchema: { message: { type: 'string', description: 'Any message' } },
	},
	async (args: Record<string, unknown>) => {
		return { content: [{ type: 'text', text: `pong: ${String(args.message ?? '')}` }] };
	},
);

// Streamable HTTP transport
const allowedHosts = (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,*.ngrok-free.dev')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

// StreamableHTTPServerTransport のコンストラクタ型が SDK で正確に export されていないためキャストを集約
type Transport = Parameters<typeof server.connect>[0];
const HttpTransport = StreamableHTTPServerTransport as unknown as new (
	opts: Record<string, unknown>,
) => Transport & {
	handleRequest?: (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>;
};
const transport = new HttpTransport({
	path: ENDPOINT,
	sessionIdGenerator: () => randomUUID(),
	enableDnsRebindingProtection: true,
	...(allowedHosts.length ? { allowedHosts } : {}),
	...(allowedOrigins.length ? { allowedOrigins } : {}),
});

await server.connect(transport);

// SDK 公式の handleRequest を使って HTTP リクエストを処理する
const mw: RequestHandler =
	typeof transport.handleRequest === 'function'
		? (req, res, next) => {
				transport.handleRequest!(req, res, req.body).catch(next);
			}
		: (_req: Request, _res: Response, next: NextFunction) => next();
app.use(ENDPOINT, mw);

app.listen(PORT, '::', () => {
	// eslint-disable-next-line no-console
	console.log(`MCP HTTP listening on http://localhost:${PORT}${ENDPOINT}`);
});
