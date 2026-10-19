/**
 * app/api/indexer/stream/route.ts
 *
 * Proxy for the indexer's GET /stream SSE endpoint.
 * This keeps CORS and auth consistent: the browser only ever talks to the
 * Next.js origin; this route forwards the connection (and Last-Event-ID)
 * upstream and pipes the response body back verbatim.
 *
 * Query params forwarded transparently: topics, wallet, lastEventId.
 *
 * Issue #1478: the incoming `traceparent` (or a freshly minted one) is
 * forwarded to the indexer so SSE connections are linked to the same
 * distributed trace as the REST requests that precede them.
 */
import { NextRequest } from 'next/server';
import {
  getOrCreateTraceContext,
  outboundTraceparent,
  TRACEPARENT_HEADER,
} from '@/lib/traceContext';

const INDEXER_BASE =
  process.env.NEXT_PUBLIC_INDEXER_API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';
// Disable body buffering so SSE frames are flushed immediately.
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;

  const upstream = new URL(`${INDEXER_BASE}/stream`);
  if (searchParams.has('topics'))
    upstream.searchParams.set('topics', searchParams.get('topics')!);
  if (searchParams.has('wallet'))
    upstream.searchParams.set('wallet', searchParams.get('wallet')!);
  if (searchParams.has('lastEventId'))
    upstream.searchParams.set('lastEventId', searchParams.get('lastEventId')!);

  const upstreamHeaders: HeadersInit = {
    Accept: 'text/event-stream',
  };

  // Issue #1478: forward W3C trace context to the indexer.
  const traceCtx = getOrCreateTraceContext(request.headers);
  upstreamHeaders[TRACEPARENT_HEADER] = outboundTraceparent(traceCtx);

  const lastEventId = request.headers.get('last-event-id');
  if (lastEventId) {
    upstreamHeaders['Last-Event-ID'] = lastEventId;
  }

  let upstreamResponse: globalThis.Response;
  try {
    upstreamResponse = await fetch(upstream.toString(), {
      headers: upstreamHeaders,
      // @ts-expect-error — Node 18+ fetch supports duplex
      duplex: 'half',
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Indexer stream unavailable' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return new Response(JSON.stringify({ error: 'Indexer stream error' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(upstreamResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
