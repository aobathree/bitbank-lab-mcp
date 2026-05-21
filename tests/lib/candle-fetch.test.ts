import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type FetchChunkResult,
	fetchCandleChunk,
	mergeChunks,
	parseCandleChunk,
	UpstreamApiError,
} from '../../lib/candle-fetch.js';
import { BITBANK_API_BASE } from '../../lib/http.js';

describe('parseCandleChunk', () => {
	it('success:1 のレスポンスから ohlcv 配列を返す', () => {
		const json = {
			success: 1,
			data: {
				candlestick: [
					{
						ohlcv: [
							['100', '110', '90', '105', '1.0', '1700000000000'],
							['105', '120', '95', '115', '2.0', '1700086400000'],
						],
					},
				],
			},
		};
		const result = parseCandleChunk(json, null);
		expect(result.error).toBeUndefined();
		expect(result.rows).toHaveLength(2);
		expect(result.rows[0]).toEqual(['100', '110', '90', '105', '1.0', '1700000000000']);
	});

	it('rateLimit を pass-through する', () => {
		const rateLimit = { remaining: 50, limit: 100, reset: 1700000000 };
		const result = parseCandleChunk({ success: 1, data: { candlestick: [{ ohlcv: [] }] } }, rateLimit);
		expect(result.rateLimit).toBe(rateLimit);
	});

	it('success:0 + data.code あり → UpstreamApiError (code を含むメッセージ)', () => {
		const result = parseCandleChunk({ success: 0, data: { code: 10000 } }, null);
		expect(result.rows).toEqual([]);
		expect(result.error).toBeInstanceOf(UpstreamApiError);
		expect((result.error as Error).message).toBe('bitbank API error (code: 10000)');
	});

	it('success:0 + data.code なし → UpstreamApiError (汎用メッセージ)', () => {
		const result = parseCandleChunk({ success: 0, data: {} }, null);
		expect(result.error).toBeInstanceOf(UpstreamApiError);
		expect((result.error as Error).message).toBe('bitbank API error');
	});

	it('success:0 でも rateLimit は pass-through する', () => {
		const rateLimit = { remaining: 1, limit: 100, reset: 1700000000 };
		const result = parseCandleChunk({ success: 0, data: { code: 10000 } }, rateLimit);
		expect(result.rateLimit).toBe(rateLimit);
	});

	it('candlestick が欠落しているケースで空配列を返す', () => {
		const result = parseCandleChunk({ success: 1, data: {} }, null);
		expect(result.rows).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it('ohlcv が欠落しているケースで空配列を返す', () => {
		const result = parseCandleChunk({ success: 1, data: { candlestick: [{}] } }, null);
		expect(result.rows).toEqual([]);
		expect(result.error).toBeUndefined();
	});
});

describe('fetchCandleChunk', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('成功レスポンスを正規化して rows を返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					success: 1,
					data: { candlestick: [{ ohlcv: [['100', '110', '90', '105', '1.0', '1700000000000']] }] },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);

		const result = await fetchCandleChunk('btc_jpy', '1day', '2024');
		expect(result.error).toBeUndefined();
		expect(result.rows).toHaveLength(1);
	});

	it('URL は BITBANK_API_BASE + pair + type + key の形になる', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ success: 1, data: { candlestick: [{ ohlcv: [] }] } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		await fetchCandleChunk('btc_jpy', '1hour', '20240115');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const calledUrl = String(fetchMock.mock.calls[0][0]);
		expect(calledUrl).toBe(`${BITBANK_API_BASE}/btc_jpy/candlestick/1hour/20240115`);
	});

	it('success:0 → UpstreamApiError を error に詰めて返す（throw しない）', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ success: 0, data: { code: 10000 } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const result = await fetchCandleChunk('btc_jpy', '1day', '2024');
		expect(result.rows).toEqual([]);
		expect(result.error).toBeInstanceOf(UpstreamApiError);
		expect((result.error as Error).message).toContain('code: 10000');
	});

	it('ネットワークエラーは error に詰めて返す（throw しない）', async () => {
		const networkErr = new TypeError('fetch failed');
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkErr);

		const result = await fetchCandleChunk('btc_jpy', '1day', '2024', { retries: 0 });
		expect(result.rows).toEqual([]);
		expect(result.rateLimit).toBeNull();
		// retries 後の最終エラーが入る（fetchJsonWithRateLimit が throw → catch でラップ）
		expect(result.error).toBeDefined();
	});

	it('リトライ後も失敗すれば error を返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('persistent failure'));

		const result = await fetchCandleChunk('btc_jpy', '1day', '2024', { retries: 1 });
		expect(result.error).toBeDefined();
	});

	it('レートリミット情報を抽出して返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ success: 1, data: { candlestick: [{ ohlcv: [] }] } }), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'X-RateLimit-Remaining': '50',
					'X-RateLimit-Limit': '100',
					'X-RateLimit-Reset': '1700000000',
				},
			}),
		);

		const result = await fetchCandleChunk('btc_jpy', '1day', '2024');
		expect(result.rateLimit).toEqual({ remaining: 50, limit: 100, reset: 1700000000 });
	});
});

describe('mergeChunks', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** タイムスタンプ付き OHLCV 行を生成するヘルパー */
	const row = (ts: number): [string, string, string, string, string, string] => [
		'100',
		'110',
		'90',
		'105',
		'1.0',
		String(ts),
	];

	it('全 chunk 成功: rows をマージして timestamp 昇順でソートする', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce({ rows: [row(3000), row(4000)], rateLimit: null } satisfies FetchChunkResult)
			.mockResolvedValueOnce({ rows: [row(1000), row(2000)], rateLimit: null } satisfies FetchChunkResult);

		const merged = await mergeChunks(['key-newer', 'key-older'], fetcher);

		expect(merged.failedKeys).toEqual([]);
		expect(merged.rows).toHaveLength(4);
		// timestamp 昇順
		expect(merged.rows.map((r) => Number(r[5]))).toEqual([1000, 2000, 3000, 4000]);
	});

	it('全 chunk が success:0 → 全て error 入り（fail は呼び出し側責務）', async () => {
		const fetcher = vi.fn().mockImplementation(async () => ({
			rows: [],
			rateLimit: null,
			error: new UpstreamApiError('bitbank API error (code: 10000)'),
		}));

		const merged = await mergeChunks(['2024', '2023'], fetcher);

		expect(merged.rows).toEqual([]);
		expect(merged.failedKeys).toEqual(['2024', '2023']);
		expect(merged.results.every((r) => r.error instanceof UpstreamApiError)).toBe(true);
	});

	it('全 chunk ネットワーク失敗 → 全て error 入り', async () => {
		const fetcher = vi.fn().mockImplementation(async () => ({
			rows: [],
			rateLimit: null,
			error: new TypeError('fetch failed'),
		}));

		const merged = await mergeChunks(['k1', 'k2', 'k3'], fetcher);
		expect(merged.rows).toEqual([]);
		expect(merged.failedKeys).toEqual(['k1', 'k2', 'k3']);
	});

	it('部分成功 → 成功 chunk の rows と failedKeys を返す', async () => {
		const fetcher = vi
			.fn()
			.mockImplementationOnce(async () => ({ rows: [row(2000)], rateLimit: null }))
			.mockImplementationOnce(async () => ({
				rows: [],
				rateLimit: null,
				error: new UpstreamApiError('bitbank API error'),
			}))
			.mockImplementationOnce(async () => ({ rows: [row(1000)], rateLimit: null }));

		const merged = await mergeChunks(['k1', 'k2', 'k3'], fetcher);
		expect(merged.rows.map((r) => Number(r[5]))).toEqual([1000, 2000]);
		expect(merged.failedKeys).toEqual(['k2']);
	});

	it('failedKeys は keys の元順序を保つ', async () => {
		const fetcher = vi.fn().mockImplementation(async (key: string) => {
			if (key === 'a' || key === 'c') {
				return { rows: [], rateLimit: null, error: new UpstreamApiError('e') };
			}
			return { rows: [row(1000)], rateLimit: null };
		});

		const merged = await mergeChunks(['a', 'b', 'c', 'd'], fetcher);
		expect(merged.failedKeys).toEqual(['a', 'c']);
	});

	it('rateLimit: 最後に得た非 null の rateLimit を採用する (last-wins)', async () => {
		const rl1 = { remaining: 99, limit: 100, reset: 1700000000 };
		const rl2 = { remaining: 50, limit: 100, reset: 1700000000 };
		const rl3 = { remaining: 10, limit: 100, reset: 1700000000 };

		const fetcher = vi
			.fn()
			.mockResolvedValueOnce({ rows: [], rateLimit: rl1 } satisfies FetchChunkResult)
			.mockResolvedValueOnce({ rows: [], rateLimit: rl2 } satisfies FetchChunkResult)
			.mockResolvedValueOnce({ rows: [], rateLimit: rl3 } satisfies FetchChunkResult);

		const merged = await mergeChunks(['k1', 'k2', 'k3'], fetcher);
		expect(merged.lastRateLimit).toBe(rl3);
	});

	it('rateLimit: null と非 null が混在しても最後の非 null を採用する', async () => {
		const rl1 = { remaining: 99, limit: 100, reset: 1700000000 };
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce({ rows: [], rateLimit: rl1 } satisfies FetchChunkResult)
			.mockResolvedValueOnce({ rows: [], rateLimit: null } satisfies FetchChunkResult);

		const merged = await mergeChunks(['k1', 'k2'], fetcher);
		expect(merged.lastRateLimit).toBe(rl1);
	});

	it('keys が空配列なら空の結果を返す', async () => {
		const fetcher = vi.fn();
		const merged = await mergeChunks([], fetcher);

		expect(merged.rows).toEqual([]);
		expect(merged.results).toEqual([]);
		expect(merged.failedKeys).toEqual([]);
		expect(merged.lastRateLimit).toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});

	describe('batched モード', () => {
		it('concurrency 単位のバッチで fetcher を実行する', async () => {
			const fetcher = vi.fn().mockImplementation(async () => ({ rows: [], rateLimit: null }));

			await mergeChunks(['a', 'b', 'c', 'd', 'e'], fetcher, {
				batched: { concurrency: 2, batchDelayMs: 0 },
			});

			expect(fetcher).toHaveBeenCalledTimes(5);
			expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c', 'd', 'e']);
		});

		it('バッチ間の遅延を挟む（先頭バッチ前は挟まない）', async () => {
			vi.useFakeTimers();
			try {
				const fetcher = vi.fn().mockImplementation(async () => ({ rows: [], rateLimit: null }));
				const promise = mergeChunks(['a', 'b', 'c'], fetcher, {
					batched: { concurrency: 2, batchDelayMs: 500 },
				});

				// 1 バッチ目（'a', 'b'）が実行されるまで microtask を進める
				await vi.advanceTimersByTimeAsync(0);
				expect(fetcher).toHaveBeenCalledTimes(2);

				// 500ms 進めると 2 バッチ目（'c'）が実行される
				await vi.advanceTimersByTimeAsync(500);
				expect(fetcher).toHaveBeenCalledTimes(3);

				await promise;
			} finally {
				vi.useRealTimers();
			}
		});

		it('バッチ並列でも全 chunk の rows をマージし timestamp 昇順でソートする', async () => {
			const fetcher = vi.fn().mockImplementation(async (key: string) => {
				const tsMap: Record<string, number> = { a: 3000, b: 1000, c: 4000, d: 2000 };
				return { rows: [row(tsMap[key])], rateLimit: null };
			});

			const merged = await mergeChunks(['a', 'b', 'c', 'd'], fetcher, {
				batched: { concurrency: 2, batchDelayMs: 0 },
			});

			expect(merged.rows.map((r) => Number(r[5]))).toEqual([1000, 2000, 3000, 4000]);
		});

		it('バッチ並列でも failedKeys は keys 順を保つ', async () => {
			const fetcher = vi.fn().mockImplementation(async (key: string) => {
				if (key === 'b' || key === 'd') {
					return { rows: [], rateLimit: null, error: new UpstreamApiError('e') };
				}
				return { rows: [row(1000)], rateLimit: null };
			});

			const merged = await mergeChunks(['a', 'b', 'c', 'd', 'e'], fetcher, {
				batched: { concurrency: 2, batchDelayMs: 0 },
			});
			expect(merged.failedKeys).toEqual(['b', 'd']);
		});
	});

	describe('並列モード（batched 未指定）', () => {
		it('全 chunk を同時並列で実行する（バッチ遅延なし）', async () => {
			const order: string[] = [];
			const fetcher = vi.fn().mockImplementation(async (key: string) => {
				order.push(`start-${key}`);
				return { rows: [], rateLimit: null };
			});

			await mergeChunks(['a', 'b', 'c'], fetcher);

			// Promise.all のため start-a/b/c が連続で呼ばれる
			expect(order).toEqual(['start-a', 'start-b', 'start-c']);
		});
	});
});
