import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import type { NextFunction, Request, RequestHandler, Response } from 'express-serve-static-core';

/**
 * MCP HTTP transport を有効化する際に必須となる Bearer トークンを返す。
 *
 * 未設定 / 空文字 / 空白のみは明示的に throw する。
 * stdio transport には影響させないため、呼び出し側 (src/http.ts や src/server.ts の
 * useHttp ブランチ) でのみ呼び出すこと。
 */
export function requireMcpHttpToken(): string {
	const raw = process.env.MCP_HTTP_TOKEN;
	// 空白のみのトークン (例: '   ') は誤設定の可能性が高く、Authorization の
	// セキュリティ境界として機能しないため明示的に拒否する。
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new Error(
			'MCP_HTTP_TOKEN is required when MCP HTTP transport is enabled. ' +
				'Set MCP_HTTP_TOKEN to a strong random secret, or disable the HTTP transport.',
		);
	}
	return raw;
}

/**
 * Authorization: Bearer <token> を検証する express ミドルウェアを生成する。
 *
 * - token 比較は crypto.timingSafeEqual で constant-time に行う
 * - ヘッダ欠落 / 不正フォーマット / 不一致 はいずれも 401 + { error: 'Unauthorized' }
 * - 長さが異なる場合は timingSafeEqual を呼ばずに 401（長さの差は Bearer プロトコル上避けられない）
 */
export function createBearerAuthMiddleware(token: string): RequestHandler {
	const expected = Buffer.from(token, 'utf8');
	return (req: Request, res: Response, next: NextFunction) => {
		const header = req.headers.authorization;
		if (typeof header !== 'string' || header.length === 0) {
			res.status(401).json({ error: 'Unauthorized' });
			return;
		}
		const match = /^Bearer\s+(.+)$/i.exec(header);
		if (!match) {
			res.status(401).json({ error: 'Unauthorized' });
			return;
		}
		const provided = Buffer.from(match[1], 'utf8');
		if (provided.length !== expected.length) {
			res.status(401).json({ error: 'Unauthorized' });
			return;
		}
		if (!timingSafeEqual(provided, expected)) {
			res.status(401).json({ error: 'Unauthorized' });
			return;
		}
		next();
	};
}

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 60;

/** env から正の有限数値を取り出す。NaN / 0 以下 / 非数値はデフォルトに落とす。 */
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * MCP HTTP transport 用の rate limit ミドルウェアを生成する。
 *
 * env:
 * - RATE_LIMIT_WINDOW_MS (default 60_000)
 * - RATE_LIMIT_MAX       (default 60)
 *
 * env が NaN / 0 / 負数の場合はデフォルトにフォールバックする
 * (誤設定で throttling が無効化されることを防ぐため)。
 */
export function createMcpRateLimiter(): RequestHandler {
	const windowMs = parsePositiveIntEnv(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS);
	const max = parsePositiveIntEnv(process.env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX);
	return rateLimit({
		windowMs,
		max,
		standardHeaders: 'draft-7',
		legacyHeaders: false,
		message: { error: 'Too many requests. Please try again later.' },
	}) as unknown as RequestHandler;
}
