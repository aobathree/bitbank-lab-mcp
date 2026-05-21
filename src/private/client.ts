/**
 * bitbank Private API HTTP クライアント。
 *
 * - 認証ヘッダーの付与を隠蔽し、ツールから直接認証を意識させない
 * - HTTP 層を注入可能にし、テスト時に mock に差し替えられる
 * - レート制限（429 / エラーコード 10009）は Retry-After に従いリトライ
 * - Base URL: https://api.bitbank.cc（public.bitbank.cc とは別）
 *
 * @see https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api.md
 * @see https://github.com/bitbankinc/bitbank-api-docs/blob/master/errors.md
 */

import { extractRateLimit, type RateLimitInfo } from '../../lib/http.js';
import { getBitbankErrorMessage } from '../lib/bitbank-errors.js';
import { createGetAuthHeaders, createPostAuthHeaders } from './auth.js';

/** テスト時に差し替え可能な HTTP fetcher 型 */
export type HttpFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** bitbank API の標準レスポンス形式 */
export interface BitbankApiResponse<T = unknown> {
	success: number;
	data: T;
}

/** Private API クライアントのエラー */
export class PrivateApiError extends Error {
	constructor(
		message: string,
		public readonly errorType: string,
		public readonly statusCode?: number,
		public readonly bitbankCode?: number,
	) {
		super(message);
		this.name = 'PrivateApiError';
	}
}

/**
 * bitbank エラーコードの分類。
 * @see https://github.com/bitbankinc/bitbank-api-docs/blob/master/errors.md
 */
// 認証系: 20001〜20005
const AUTH_ERROR_CODES = new Set([20001, 20002, 20003, 20004, 20005]);
// レート制限: 10009
const RATE_LIMIT_CODES = new Set([10009]);
// メンテナンス/過負荷: 10007, 10008
const MAINTENANCE_CODES = new Set([10007, 10008]);

export interface PrivateClientOptions {
	fetcher?: HttpFetcher;
	timeoutMs?: number;
	maxRetries?: number;
}

export class BitbankPrivateClient {
	private static readonly BASE_URL = 'https://api.bitbank.cc';
	private readonly fetcher: HttpFetcher;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;

	/** 直近の成功レスポンスから抽出したレートリミット情報（ヘッダ未提供時は null） */
	lastRateLimit: RateLimitInfo | null = null;

	constructor(opts: PrivateClientOptions = {}) {
		this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = opts.timeoutMs ?? 5000;
		this.maxRetries = opts.maxRetries ?? 2;
	}

	/**
	 * GET リクエスト
	 * @param path - API パス（例: '/v1/user/assets'）
	 * @param params - クエリパラメータ
	 */
	async get<T>(path: string, params?: Record<string, string>): Promise<T> {
		let fullPath = path;
		if (params) {
			const qs = new URLSearchParams(params).toString();
			if (qs) fullPath = `${path}?${qs}`;
		}

		const url = `${BitbankPrivateClient.BASE_URL}${fullPath}`;
		const headers = createGetAuthHeaders(fullPath);

		return this.request<T>(url, {
			method: 'GET',
			headers: {
				...headers,
				'Content-Type': 'application/json',
			},
		});
	}

	/**
	 * POST リクエスト
	 *
	 * 状態変化を伴う POST（注文発注・キャンセル等）はネットワーク/タイムアウト/5xx
	 * 全経路で自動リトライしない。リトライ時の二重注文を防ぐため defense-in-depth として
	 * `retries: 0` を強制する。再試行はユーザー起点で preview から再実行する想定。
	 *
	 * @param path - API パス
	 * @param body - リクエストボディ
	 */
	async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
		const url = `${BitbankPrivateClient.BASE_URL}${path}`;
		const jsonBody = JSON.stringify(body);
		const headers = createPostAuthHeaders(jsonBody);

		return this.request<T>(
			url,
			{
				method: 'POST',
				headers: {
					...headers,
					'Content-Type': 'application/json',
				},
				body: jsonBody,
			},
			{ retries: 0 },
		);
	}

	/**
	 * 共通リクエスト処理（リトライ・タイムアウト・エラーハンドリング）
	 *
	 * @param opts.retries - リトライ上限のオーバーライド。指定時はこの値、
	 *   未指定なら `this.maxRetries` を採用する。POST のような非冪等リクエストは
	 *   呼び出し側で `0` を渡す。
	 */
	private async request<T>(url: string, init: RequestInit, opts: { retries?: number } = {}): Promise<T> {
		const maxRetries = opts.retries ?? this.maxRetries;
		let lastErr: unknown;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

			try {
				const res = await this.fetcher(url, { ...init, signal: ctrl.signal });
				clearTimeout(timer);

				// 429 Rate Limit（HTTP レベル）
				if (res.status === 429) {
					const retryAfter = res.headers.get('Retry-After');
					const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
					if (attempt < maxRetries) {
						await new Promise((r) => setTimeout(r, waitMs));
						continue;
					}
					throw new PrivateApiError(
						`レート制限超過。${retryAfter ? `${retryAfter}秒` : 'しばらく'}待ってから再試行してください`,
						'rate_limit_error',
						429,
					);
				}

				// 5xx Server Error
				if (res.status >= 500) {
					if (attempt < maxRetries) {
						await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
						continue;
					}
					throw new PrivateApiError(
						`bitbank サーバーエラー (HTTP ${res.status})。一時的な障害の可能性があります`,
						'upstream_error',
						res.status,
					);
				}

				// レスポンスボディを取得
				const body = await res.text().catch(() => '');

				// HTTP エラー（4xx 等）
				if (!res.ok) {
					const errorCode = this.extractErrorCode(body);
					throw this.classifyBitbankError(res.status, errorCode);
				}

				// Success レスポンスのパース
				let json: BitbankApiResponse<T>;
				try {
					json = JSON.parse(body) as BitbankApiResponse<T>;
				} catch {
					throw new PrivateApiError('レスポンスの JSON パースに失敗しました', 'upstream_error');
				}

				// レートリミット情報を抽出（成功時）
				this.lastRateLimit = extractRateLimit(res.headers);

				// success: 0 の場合（HTTP 200 でもエラー）
				if (json.success !== 1) {
					const errorCode = (json.data as Record<string, unknown>)?.code as number | undefined;

					// レート制限エラーはリトライ
					if (errorCode != null && RATE_LIMIT_CODES.has(errorCode)) {
						if (attempt < maxRetries) {
							await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
							continue;
						}
					}

					throw this.classifyBitbankError(200, errorCode ?? null);
				}

				return json.data;
			} catch (err) {
				clearTimeout(timer);
				if (err instanceof PrivateApiError) throw err;

				// AbortError = timeout
				if (err instanceof Error && err.name === 'AbortError') {
					lastErr = new PrivateApiError(`タイムアウト (${this.timeoutMs}ms)`, 'upstream_error');
				} else {
					lastErr = err;
				}

				if (attempt < maxRetries) {
					await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
				}
			}
		}

		if (lastErr instanceof PrivateApiError) throw lastErr;
		throw new PrivateApiError(lastErr instanceof Error ? lastErr.message : 'ネットワークエラー', 'upstream_error');
	}

	/** bitbank エラーレスポンスからエラーコードを抽出 */
	private extractErrorCode(body: string): number | null {
		try {
			const parsed = JSON.parse(body);
			return parsed?.data?.code ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * bitbank エラーコードを分類し、適切な PrivateApiError を生成する。
	 *
	 * エラーコード体系:
	 * - 10000 番台: システムエラー（10009 はレート制限）
	 * - 20000 番台: 認証エラー
	 * - 30000 番台: 必須パラメータ不足
	 * - 40000 番台: パラメータ不正
	 * - 50000 番台: データエラー
	 * - 60000 番台: 数値制限超過
	 * - 70000 番台: 取引制限中
	 */
	private classifyBitbankError(httpStatus: number, errorCode: number | null): PrivateApiError {
		// 認証エラー
		if (errorCode != null && AUTH_ERROR_CODES.has(errorCode)) {
			const details: Record<number, string> = {
				20001: 'API 認証に失敗しました',
				20002: 'API キーが無効です',
				20003: 'API キーが見つかりません',
				20004: 'ACCESS-NONCE / ACCESS-REQUEST-TIME が未指定です',
				20005: '署名が無効です。API シークレットを確認してください',
			};
			return new PrivateApiError(details[errorCode] ?? 'API 認証エラー', 'authentication_error', httpStatus, errorCode);
		}

		// レート制限
		if (errorCode != null && RATE_LIMIT_CODES.has(errorCode)) {
			return new PrivateApiError(
				'リクエスト頻度が高すぎます。しばらく待ってから再試行してください',
				'rate_limit_error',
				httpStatus,
				errorCode,
			);
		}

		// メンテナンス / 過負荷
		if (errorCode != null && MAINTENANCE_CODES.has(errorCode)) {
			return new PrivateApiError(
				errorCode === 10007
					? 'bitbank はメンテナンス中です'
					: 'bitbank サーバーが過負荷状態です。しばらく待ってから再試行してください',
				'upstream_error',
				httpStatus,
				errorCode,
			);
		}

		// HTTP 401/403（エラーコードなし）
		if (httpStatus === 401 || httpStatus === 403) {
			return new PrivateApiError(
				'API キーまたは署名が不正です。bitbank 管理画面でキーを確認してください',
				'authentication_error',
				httpStatus,
				errorCode ?? undefined,
			);
		}

		// 共通テーブルに登録されたコード
		if (errorCode != null) {
			const libMessage = getBitbankErrorMessage(errorCode);
			if (libMessage) {
				return new PrivateApiError(libMessage, 'upstream_error', httpStatus, errorCode);
			}
		}

		// その他
		return new PrivateApiError(
			`bitbank API エラー (HTTP ${httpStatus}${errorCode ? `, code: ${errorCode}` : ''})`,
			'upstream_error',
			httpStatus,
			errorCode ?? undefined,
		);
	}
}

/** デフォルトのシングルトンインスタンス */
let defaultClient: BitbankPrivateClient | null = null;

export function getDefaultClient(): BitbankPrivateClient {
	if (!defaultClient) {
		defaultClient = new BitbankPrivateClient();
	}
	return defaultClient;
}
