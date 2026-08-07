// Tiny shared shape for a Route Handler's error responses — every server
// route in this app (tts/route.ts, noise-reduction/*) reports a validation
// or upstream failure the same way: `{ error: string }` JSON at the given
// status. No secrets/server-only imports here, so this is safe in utils/
// alongside cartesiaVoices.ts's own "shared, safe anywhere" convention.

export function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
