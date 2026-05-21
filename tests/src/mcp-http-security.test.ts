import type http from 'node:http';
import { createServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createBearerAuthMiddleware, createMcpRateLimiter, requireMcpHttpToken } from '../../lib/mcp-http-security.js';

/**
 * MCP HTTP transport セキュリティヘルパーのユニットテスト。
 * - requireMcpHttpToken: env 未設定で throw（stdio に影響を与えないことが前提）
 * - createBearerAuthMiddleware: 401 / 200 のレスポンス挙動
 *
 * SKIP_NETWORK_TESTS=1 が指定された環境では localhost bind を伴うテストを skip する。
 */

type ProbeResult = { ok: true } | { ok: false; reason: string };

async function probeLocalhostBind(): Promise<ProbeResult> {
	if (process.env.SKIP_NETWORK_TESTS === '1') {
		return { ok: false, reason: 'SKIP_NETWORK_TESTS=1 が指定されています' };
	}
	return new Promise<ProbeResult>((resolve) => {
		const srv = createServer();
		srv.once('error', (err) => {
			const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
			if (code === 'EACCES' || code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'EPERM') {
				resolve({ ok: false, reason: `127.0.0.1:0 への bind が ${code} で失敗 (サンドボックス環境の可能性)` });
			} else {
				resolve({ ok: true });
			}
		});
		srv.once('listening', () => {
			srv.close(() => resolve({ ok: true }));
		});
		srv.listen(0, '127.0.0.1');
	});
}

const probe = await probeLocalhostBind();
const SKIP_NET = !probe.ok;

function listenLocal(app: express.Express): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const srv = app.listen(0, '127.0.0.1');
		srv.once('listening', () => {
			srv.removeListener('error', reject);
			resolve(srv);
		});
		srv.once('error', reject);
	});
}

function addressOf(srv: http.Server): { host: string; port: number } {
	const addr = srv.address();
	if (!addr || typeof addr === 'string') {
		throw new Error('server.address() returned invalid value');
	}
	return { host: '127.0.0.1', port: addr.port };
}

describe('requireMcpHttpToken', () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('MCP_HTTP_TOKEN が設定されていれば値を返す', () => {
		process.env.MCP_HTTP_TOKEN = 'my-secret';
		expect(requireMcpHttpToken()).toBe('my-secret');
	});

	it('MCP_HTTP_TOKEN が未設定なら throw する', () => {
		delete process.env.MCP_HTTP_TOKEN;
		expect(() => requireMcpHttpToken()).toThrow(/MCP_HTTP_TOKEN is required/);
	});

	it('MCP_HTTP_TOKEN が空文字なら throw する', () => {
		process.env.MCP_HTTP_TOKEN = '';
		expect(() => requireMcpHttpToken()).toThrow(/MCP_HTTP_TOKEN is required/);
	});

	it.each(['   ', '\t', '\n', ' \t\n '])('MCP_HTTP_TOKEN が空白のみなら throw する (%j)', (value) => {
		process.env.MCP_HTTP_TOKEN = value;
		expect(() => requireMcpHttpToken()).toThrow(/MCP_HTTP_TOKEN is required/);
	});

	it('throw されるエラーメッセージに "HTTP transport" の文脈が含まれる (運用者向けヒント)', () => {
		delete process.env.MCP_HTTP_TOKEN;
		expect(() => requireMcpHttpToken()).toThrow(/HTTP transport/);
	});
});

describe.skipIf(SKIP_NET)('createMcpRateLimiter env validation', () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	async function probeLimiter(limiterMiddleware: ReturnType<typeof createMcpRateLimiter>) {
		const app = express();
		app.use(limiterMiddleware);
		app.get('/', (_req, res) => res.json({ ok: true }));
		const srv = await listenLocal(app);
		try {
			const { port } = addressOf(srv);
			const res = await fetch(`http://127.0.0.1:${port}/`);
			return { status: res.status, ratelimit: res.headers.get('ratelimit') };
		} finally {
			await new Promise<void>((resolve, reject) => {
				srv.close((err) => (err ? reject(err) : resolve()));
			});
		}
	}

	it.each(['NaN', '0', '-1', 'abc', ''])('RATE_LIMIT_MAX=%j ならデフォルト 60 にフォールバック', async (value) => {
		process.env.RATE_LIMIT_MAX = value;
		const { status, ratelimit } = await probeLimiter(createMcpRateLimiter());
		expect(status).toBe(200);
		expect(ratelimit).toContain('limit=60');
	});

	it.each([
		'NaN',
		'0',
		'-1',
		'abc',
	])('RATE_LIMIT_WINDOW_MS=%j でもデフォルトで起動できる (limiter 構築失敗しない)', async (value) => {
		process.env.RATE_LIMIT_WINDOW_MS = value;
		const { status } = await probeLimiter(createMcpRateLimiter());
		expect(status).toBe(200);
	});

	it('正の値はそのまま反映される', async () => {
		process.env.RATE_LIMIT_MAX = '42';
		const { ratelimit } = await probeLimiter(createMcpRateLimiter());
		expect(ratelimit).toContain('limit=42');
	});
});

describe.skipIf(SKIP_NET)('createBearerAuthMiddleware', () => {
	const TOKEN = 'unit-test-token-abcdef';

	async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
		const app = express();
		app.use(createBearerAuthMiddleware(TOKEN));
		app.get('/', (_req, res) => res.json({ ok: true }));
		const srv = await listenLocal(app);
		try {
			const { port } = addressOf(srv);
			return await fn(`http://127.0.0.1:${port}`);
		} finally {
			await new Promise<void>((resolve, reject) => {
				srv.close((err) => (err ? reject(err) : resolve()));
			});
		}
	}

	it('ヘッダなし → 401 Unauthorized', async () => {
		await withServer(async (baseUrl) => {
			const res = await fetch(baseUrl);
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe('Unauthorized');
		});
	});

	it('空文字 Authorization → 401', async () => {
		await withServer(async (baseUrl) => {
			const res = await fetch(baseUrl, { headers: { Authorization: '' } });
			expect(res.status).toBe(401);
		});
	});

	it('Bearer 以外のスキーム → 401', async () => {
		await withServer(async (baseUrl) => {
			const res = await fetch(baseUrl, { headers: { Authorization: `Token ${TOKEN}` } });
			expect(res.status).toBe(401);
		});
	});

	it('Bearer の後ろにトークンが無い → 401', async () => {
		await withServer(async (baseUrl) => {
			const res = await fetch(baseUrl, { headers: { Authorization: 'Bearer ' } });
			expect(res.status).toBe(401);
		});
	});

	it('長さの異なる Bearer トークン → 401 (timingSafeEqual を呼ばずに弾く)', async () => {
		await withServer(async (baseUrl) => {
			const res = await fetch(baseUrl, { headers: { Authorization: 'Bearer short' } });
			expect(res.status).toBe(401);
		});
	});

	it('同じ長さで内容が違う Bearer トークン → 401', async () => {
		await withServer(async (baseUrl) => {
			const wrong = 'X'.repeat(TOKEN.length);
			const res = await fetch(baseUrl, { headers: { Authorization: `Bearer ${wrong}` } });
			expect(res.status).toBe(401);
		});
	});

	it('正しい Bearer トークン → 200 (next() でハンドラ到達)', async () => {
		await withServer(async (baseUrl) => {
			const res = await fetch(baseUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
		});
	});

	it('Bearer の大文字小文字を区別しない (RFC 6750)', async () => {
		await withServer(async (baseUrl) => {
			const res = await fetch(baseUrl, { headers: { Authorization: `bearer ${TOKEN}` } });
			expect(res.status).toBe(200);
		});
	});
});
