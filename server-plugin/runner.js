const SUPPORTED = ['chat-completions', 'text-completions', 'kobold'];
const aborters = new Map();   // jobId -> AbortController

/**
 * Executes detached generation jobs by re-issuing the client's exact request to ST's own
 * backend endpoint over localhost. The abort trigger in the backends
 * (request.socket.on('close') -> controller.abort()) fires only if THIS server-side
 * socket closes — never because a browser tab died.
 */
export class JobRunner {
    static SUPPORTED = SUPPORTED;

    constructor(store) {
        this.store = store;
    }

    start(job, ctx) {
        const controller = new AbortController();
        aborters.set(job.id, controller);
        // deliberately not awaited: submit must return 202 immediately
        this.#run(job, ctx, controller).catch(err => {
            if (controller.signal.aborted) {
                this.#finishCancelled(job.id);
            } else {
                this.store.update(job.id, {
                    state: 'error',
                    error: String(err?.message ?? err),
                    finishedAt: Date.now(),
                });
            }
        });
    }

    cancel(id) {
        aborters.get(id)?.abort();
    }

    #finishCancelled(id) {
        this.store.update(id, { state: 'cancelled', finishedAt: Date.now() });
        aborters.delete(id);
    }

    async #run(job, ctx, controller) {
        this.store.update(job.id, { state: 'running', startedAt: Date.now() });

        const url = `${ctx.origin}/api/backends/${job.backend}/generate`;
        let upstream;
        try {
            upstream = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...ctx.headers },
                body: JSON.stringify(ctx.generate_data),
                signal: controller.signal,
            });
        } catch (err) {
            if (controller.signal.aborted) return this.#finishCancelled(job.id);
            throw err;
        }
        if (controller.signal.aborted) return this.#finishCancelled(job.id);

        this.store.update(job.id, { upstreamStatus: upstream.status });

        // mirror forwardFetchResponse's !ok handling (src/util.js:748-760)
        if (!upstream.ok) {
            const detail = (await upstream.text().catch(() => '')) || 'Unknown error occurred';
            return this.store.update(job.id, { state: 'error', error: detail, finishedAt: Date.now() });
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let reasoning = '';
        let tail = '';
        const process = (decoded) => {
            const parsed = this.#extract(decoded, tail);
            tail = parsed.remainder;
            text += parsed.text;
            reasoning += parsed.reasoning;
        };
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) {
                reader.cancel().catch(() => { });
                return this.#finishCancelled(job.id);
            }
            this.store.appendChunk(job.id, Buffer.from(value));
            process(decoder.decode(value, { stream: true }));
        }
        // flush any final unterminated frame (not all backends end chunks with \n\n)
        process(decoder.decode());

        const result = { text, reasoning };
        this.store.writeResult(job.id, result);
        this.store.update(job.id, { state: 'done', finishedAt: Date.now() });
        aborters.delete(job.id);
    }

    /** Best-effort text accumulation from OpenAI-shaped SSE frames. The authoritative
     *  parse always happens client-side from the raw replay; this only powers the
     *  claim/reattach insertion path. Never throws. */
    #extract(chunk, tail) {
        let text = '';
        let reasoning = '';
        let remainder = tail + chunk;
        const frames = remainder.split('\n\n');
        remainder = frames.pop() ?? '';
        for (const frame of frames) {
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const choice = parsed?.choices?.[0] ?? {};
                    const delta = choice.delta ?? choice;
                    text += delta.content ?? delta.text ?? '';
                    reasoning += delta.reasoning_content ?? delta.reasoning ?? '';
                } catch {
                    // non-JSON frame (plain-text kobold streams etc.): keep raw line
                    text += data;
                }
            }
        }
        return { text, reasoning, remainder };
    }
}
