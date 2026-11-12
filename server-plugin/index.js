import { Router } from 'express';
import { getConfigValue } from '../../src/util.js';
import { JobStore } from './jobStore.js';
import { JobRunner } from './runner.js';

export const info = {
    id: 'detached',
    name: 'Detached Generation',
    description: 'Runs LLM generations server-side so the browser can be closed mid-generation.',
};

const store = new JobStore();
const runner = new JobRunner(store);

function owner(req) {
    return req.user?.profile?.handle ?? 'default-user';
}

export async function init(router) {
    await store.init();

    // Takes the exact payload the client would have sent to the backend, returns a
    // job id immediately, and runs the generation on a plugin-owned localhost socket.
    router.post('/submit', async (req, res) => {
        try {
            const { backend, generate_data, chat } = req.body ?? {};
            if (!JobRunner.SUPPORTED.includes(backend)) {
                return res.status(400).json({ error: `Unsupported backend: ${backend}` });
            }
            if (!generate_data || typeof generate_data !== 'object') {
                return res.status(400).json({ error: 'generate_data missing' });
            }
            if (!store.canSubmit(owner(req))) {
                return res.status(429).json({ error: 'Too many running jobs' });
            }
            const job = store.create(owner(req), { backend, chat: chat ?? null });
            runner.start(job, {
                generate_data,
                origin: `http://127.0.0.1:${getConfigValue('port', 8000)}`,
                headers: {
                    cookie: req.headers.cookie ?? '',
                    'x-csrf-token': req.headers['x-csrf-token'] ?? '',
                    ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
                },
            });
            return res.status(202).json({ jobId: job.id });
        } catch (err) {
            return res.status(500).json({ error: String(err?.message ?? err) });
        }
    });

    router.get('/status', (req, res) => {
        const job = store.getOwned(String(req.query.jobId ?? ''), owner(req));
        if (!job) return res.status(404).json({ error: 'No such job' });
        return res.json(store.publicView(job));
    });

    // Raw byte replay of the recorded upstream SSE stream from a byte offset.
    // Long-polls while the job is still running. format matches what the backend
    // piped to the client (forwardFetchResponse pipes upstream bytes verbatim).
    router.get('/stream', async (req, res) => {
        const job = store.getOwned(String(req.query.jobId ?? ''), owner(req));
        if (!job) return res.status(404).json({ error: 'No such job' });
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('cache-control', 'no-store');
        res.flushHeaders?.();
        let offset = Math.max(0, Number(req.query.since ?? 0));
        try {
            while (true) {
                const { buf, size } = store.readFrom(job.id, offset);
                if (buf.length) {
                    res.write(buf);
                    offset = size;
                }
                if (store.isTerminal(job.id) && offset >= size) break;
                await store.waitForChange(job.id, 250);
                if (res.writableEnded || res.destroyed) return;
            }
        } finally {
            res.end();
        }
    });

    // The ONLY way a running job stops (replaces the stock socket-close-as-stop).
    router.post('/cancel', (req, res) => {
        const job = store.getOwned(String(req.body?.jobId ?? ''), owner(req));
        if (!job) return res.status(404).json({ error: 'No such job' });
        runner.cancel(job.id);
        return res.json({ ok: true });
    });

    // Idempotent result pickup for the reattach path; marks the job consumed.
    router.post('/claim', (req, res) => {
        const handle = owner(req);
        const job = store.getOwned(String(req.body?.jobId ?? ''), handle);
        if (!job) return res.status(404).json({ error: 'No such job' });
        return res.json(store.claim(job.id, handle));
    });

    // Unfinished or finished-but-unclaimed jobs for this user (reattach source).
    router.get('/pending', (req, res) => {
        return res.json({ jobs: store.pendingFor(owner(req)) });
    });
}
