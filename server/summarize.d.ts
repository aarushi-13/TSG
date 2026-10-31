import type { IncomingMessage, ServerResponse } from 'node:http'

/** POST /api/summarize — streams a plain-text summary of the posted document text. */
export declare function handleSummarize(request: IncomingMessage, response: ServerResponse): Promise<void>
export default handleSummarize
