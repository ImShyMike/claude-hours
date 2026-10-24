// A JSON answer gzipped when the browser takes it: a summary is mostly
// repeated keys, polled every 30 s, and nothing in front of the hub
// compresses it
export function gzipped(request: Request, response: Response) {
  const json = response.headers.get('content-type')?.startsWith('application/json')
  if (!json || !response.body || response.headers.has('content-encoding')) return response
  if (!/\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')) return response
  const headers = new Headers(response.headers)
  headers.set('content-encoding', 'gzip')
  headers.append('vary', 'accept-encoding')
  headers.delete('content-length')
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), { status: response.status, statusText: response.statusText, headers })
}
