import type http from 'node:http';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBearerAuthMiddleware, createMcpRateLimiter } from '../../lib/mcp-http-security.js';

/**
 * src/http.ts および src/server.ts の HTTP transport で適用する
 * rate limit + Bearer 認証 ミドルウェアの結合動作を検証する。
 *
 * stdio トランスポートにはこれらが適用されないことを暗黙的に保証
 * （express ミドルウェアなので HTTP 以外には影響しない）。
 *
 * SKIP_NETWORK_TESTS=1 または 127.0.0.1:0 への bind が EACCES/EADDRNOTAVAIL 等で
 * 失敗するサンドボックス環境では describe ごと skip する。
 * （実装バグと環境制約を区別するため、原因不明の listen 失敗は throw する。）
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 3; // テスト用に少数
const TEST_TOKEN = 'test-secret-token-1234567890';

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
				// 想定外のエラーは握り潰さず実テストでも fail させたいので ok 扱いにする
				resolve({ ok: true });
			}
		});
		srv.once('listening', () => {
			srv.close(() => resolve({ ok: true }));
		});
		srv.listen(0, '127.0.0.1');
	});
}

// vitest はテストファイルをトップレベルで評価する。
// describe.skipIf に渡す条件を確定させるため、ここで bind probe を await する。
const probe = await probeLocalhostBind();
const SKIP = !probe.ok;
const SKIP_REASON = probe.ok ? '' : probe.reason;

if (SKIP) {
	console.warn(`[http-rate-limit] skipping suite: ${SKIP_REASON}`);
}

/**
 * 127.0.0.1:0 で listen し、bind 完了まで待つ。
 * - 成功 → http.Server を返す
 * - 失敗 → reject (EACCES, EADDRNOTAVAIL 等)
 */
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
		throw new Error(
			`server.address() returned ${addr === null ? 'null' : `string=${addr}`}; ` +
				'listen が完了していない可能性があります。',
		);
	}
	return { host: '127.0.0.1', port: addr.port };
}

/** テスト固有の max/window で createMcpRateLimiter() を生成する。
 *  env を一時上書きする方式で実装の env パスを実際に通す。 */
function buildLimiterWithEnv(max: number, windowMs: number) {
	const prevMax = process.env.RATE_LIMIT_MAX;
	const prevWindow = process.env.RATE_LIMIT_WINDOW_MS;
	process.env.RATE_LIMIT_MAX = String(max);
	process.env.RATE_LIMIT_WINDOW_MS = String(windowMs);
	try {
		return createMcpRateLimiter();
	} finally {
		if (prevMax === undefined) delete process.env.RATE_LIMIT_MAX;
		else process.env.RATE_LIMIT_MAX = prevMax;
		if (prevWindow === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
		else process.env.RATE_LIMIT_WINDOW_MS = prevWindow;
	}
}

/** src/http.ts と同じ「rate limit → Bearer 認証 → ハンドラ」のスタックを構築する。 */
function buildProtectedApp(opts: { token: string; max?: number }): express.Express {
	const app = express();
	app.use(express.json());

	app.use('/mcp', buildLimiterWithEnv(opts.max ?? MAX_REQUESTS, WINDOW_MS));
	app.use('/mcp', createBearerAuthMiddleware(opts.token));
	app.post('/mcp', (_req, res) => {
		res.json({ ok: true });
	});
	app.get('/mcp', (_req, res) => {
		res.json({ ok: true, method: 'GET' });
	});

	// レート制限・認証の対象外
	app.get('/health', (_req, res) => {
		res.json({ ok: true });
	});
	return app;
}

describe.skipIf(SKIP)('HTTP /mcp protection (Bearer auth + rate limit)', () => {
	let server: http.Server;
	let baseUrl: string;

	beforeAll(async () => {
		// auth 挙動を検証する describe では rate limit を緩く取り、
		// 複数テスト間で 429 が混ざらないようにする (rate limit 自体は別 describe で検証)
		server = await listenLocal(buildProtectedApp({ token: TEST_TOKEN, max: 100 }));
		const { host, port } = addressOf(server);
		baseUrl = `http://${host}:${port}`;
	});

	afterAll(async () => {
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	});

	it('Authorization ヘッダなし → 401', async () => {
		const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('Unauthorized');
	});

	it('Bearer ではないスキーム (Basic 等) → 401', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { Authorization: `Basic ${TEST_TOKEN}` },
		});
		expect(res.status).toBe(401);
	});

	it('不正な Bearer トークン → 401', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { Authorization: 'Bearer wrong-token' },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('Unauthorized');
	});

	it('長さが一致するが値が異なる Bearer トークン → 401 (timing-safe path)', async () => {
		// expected と同じ長さの異なる値
		const sameLen = 'X'.repeat(TEST_TOKEN.length);
		expect(sameLen.length).toBe(TEST_TOKEN.length);
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${sameLen}` },
		});
		expect(res.status).toBe(401);
	});

	it('正しい Bearer → 200 (ハンドラ到達)', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${TEST_TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		// draft-7: combined RateLimit ヘッダ（rate limit が適用されている証跡）
		const rl = res.headers.get('ratelimit');
		expect(rl).toContain('limit=100');
	});

	it('GET /mcp も Bearer 認証必須', async () => {
		const res = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
		expect(res.status).toBe(401);
	});

	it('/health は認証・レート制限の対象外', async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
	});
});

describe.skipIf(SKIP)('HTTP rate limiting on /mcp', () => {
	let server: http.Server;
	let baseUrl: string;

	beforeAll(async () => {
		server = await listenLocal(buildProtectedApp({ token: TEST_TOKEN }));
		const { host, port } = addressOf(server);
		baseUrl = `http://${host}:${port}`;
	});

	afterAll(async () => {
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	});

	const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

	it('制限内のリクエストは 200 を返す', async () => {
		const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: authHeader });
		expect(res.status).toBe(200);
		const rl = res.headers.get('ratelimit');
		expect(rl).toContain(`limit=${MAX_REQUESTS}`);
	});

	it('制限超過で 429 を返す', async () => {
		// 残り枠を使い切る（beforeAll → 直前の it で 1 回使用済みなので MAX-1 回追加）
		for (let i = 0; i < MAX_REQUESTS - 1; i++) {
			await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: authHeader });
		}

		const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: authHeader });
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('Too many requests');
	});

	it('/health はレート制限の対象外', async () => {
		// /mcp が制限超過でも /health は影響を受けない
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
	});

	it('rate limit は認証前に評価される (未認証でも 429 を返しうる)', async () => {
		// 別アプリで小さい max=2 を作り、未認証リクエストを連発する
		const app = buildProtectedApp({ token: TEST_TOKEN, max: 2 });
		const srv = await listenLocal(app);
		const { port } = addressOf(srv);
		try {
			// 2 回までは 401 (auth fail), 3 回目で 429
			const r1 = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
			expect(r1.status).toBe(401);
			const r2 = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
			expect(r2.status).toBe(401);
			const r3 = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
			expect(r3.status).toBe(429);
		} finally {
			await new Promise<void>((resolve, reject) => {
				srv.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});
});

describe.skipIf(SKIP)('rate limit response headers', () => {
	it('レスポンスに RateLimit 標準ヘッダが含まれる', async () => {
		const app = buildProtectedApp({ token: TEST_TOKEN, max: 10 });
		const srv = await listenLocal(app);
		const { port } = addressOf(srv);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${TEST_TOKEN}` },
			});
			expect(res.status).toBe(200);
			// draft-7: "limit=10, remaining=9, reset=N" 形式
			const rl = res.headers.get('ratelimit');
			expect(rl).toContain('limit=10');
			expect(rl).toContain('remaining=9');
			expect(rl).toMatch(/reset=\d+/);
			expect(res.headers.get('ratelimit-policy')).toBeTruthy();
		} finally {
			await new Promise<void>((resolve, reject) => {
				srv.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});
});
