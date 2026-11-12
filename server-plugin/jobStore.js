import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PER_USER = 2;
const MAX_TOTAL = 8;
const TERMINAL_STATES = ['done', 'error', 'cancelled', 'interrupted'];

export class JobStore {
    constructor() {
        this.jobs = new Map();      // id -> job metadata
        this.waiters = new Map();   // id -> Set<resolve>
        this.root = null;
    }

    async init() {
        this.root = path.join(globalThis.DATA_ROOT ?? path.resolve(process.cwd(), 'data'), 'detached-jobs');
        fs.mkdirSync(this.root, { recursive: true });
        for (const owner of fs.readdirSync(this.root, { withFileTypes: true })) {
            if (!owner.isDirectory()) continue;
            const ownerDir = path.join(this.root, owner.name);
            for (const entry of fs.readdirSync(ownerDir, { withFileTypes: true })) {
                if (entry.isDirectory()) this.#loadJob(owner.name, entry.name);
            }
        }
        this.#prune();
    }

    #loadJob(owner, id) {
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(this.#jobPath(owner, id), 'job.json'), 'utf8'));
            // A job still in-flight at boot was orphaned by a server restart
            if (!TERMINAL_STATES.includes(meta.state)) {
                meta.state = 'interrupted';
                meta.error ??= 'Server restarted while generation was in progress';
                meta.finishedAt = Date.now();
                this.#persist(meta);
            }
            this.jobs.set(id, meta);
        } catch {
            // unreadable job dir: leave on disk for manual inspection, skip
        }
    }

    #jobPath(owner, id) { return path.join(this.root, owner, id); }

    #chunksPath(owner, id) { return path.join(this.#jobPath(owner, id), 'chunks.bin'); }

    create(owner, meta) {
        const id = crypto.randomUUID();
        const job = {
            id,
            owner,
            backend: meta.backend,
            chat: meta.chat ?? null,
            state: 'queued',
            upstreamStatus: null,
            bytes: 0,
            error: null,
            claimedAt: null,
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
        };
        fs.mkdirSync(this.#jobPath(owner, id), { recursive: true });
        this.#persist(job);
        this.jobs.set(id, job);
        this.#emit(id);
        return job;
    }

    get(id) { return this.jobs.get(id) ?? null; }

    getOwned(id, owner) {
        const job = this.jobs.get(id);
        return job && job.owner === owner ? job : null;
    }

    canSubmit(owner) {
        let total = 0;
        let mine = 0;
        for (const job of this.jobs.values()) {
            if (TERMINAL_STATES.includes(job.state)) continue;
            total++;
            if (job.owner === owner) mine++;
        }
        return mine < MAX_PER_USER && total < MAX_TOTAL;
    }

    update(id, patch) {
        const job = this.jobs.get(id);
        if (!job) return null;
        Object.assign(job, patch);
        this.#persist(job);
        this.#emit(id);
        return job;
    }

    appendChunk(id, buf) {
        const job = this.jobs.get(id);
        if (!job) return;
        fs.appendFileSync(this.#chunksPath(job.owner, id), buf);
        job.bytes += buf.length;
        this.#emit(id);
    }

    /** Reads recorded stream bytes from `offset`. Returns { buf, size } where size is
     *  the current total file size (use as next offset). */
    readFrom(id, offset) {
        const job = this.jobs.get(id);
        if (!job) return { buf: Buffer.alloc(0), size: 0 };
        const file = this.#chunksPath(job.owner, id);
        let size = 0;
        try { size = fs.statSync(file).size; } catch { return { buf: Buffer.alloc(0), size: 0 }; }
        if (offset >= size) return { buf: Buffer.alloc(0), size };
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            return { buf, size };
        } finally {
            fs.closeSync(fd);
        }
    }

    writeResult(id, result) {
        const job = this.jobs.get(id);
        if (!job) return;
        fs.writeFileSync(path.join(this.#jobPath(job.owner, id), 'result.json'), JSON.stringify(result));
    }

    isTerminal(id) {
        const job = this.jobs.get(id);
        return Boolean(job && TERMINAL_STATES.includes(job.state));
    }

    /** Idempotent result pickup. First claim returns the result; later claims report
     *  already-claimed so multi-tab clients cannot double-insert. */
    claim(id, owner) {
        const job = this.getOwned(id, owner);
        if (!job) return null;
        if (job.state === 'queued' || job.state === 'running') return { state: job.state };
        if (job.claimedAt) return { state: job.state, claimed: true, error: 'Already claimed by another client' };
        job.claimedAt = Date.now();
        this.#persist(job);
        return this.publicResult(job);
    }

    publicView(job) {
        return {
            id: job.id,
            state: job.state,
            backend: job.backend,
            chat: job.chat,
            upstreamStatus: job.upstreamStatus,
            bytes: job.bytes,
            error: job.error,
            claimedAt: job.claimedAt,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
        };
    }

    publicResult(job) {
        const view = this.publicView(job);
        try {
            view.result = JSON.parse(fs.readFileSync(path.join(this.#jobPath(job.owner, job.id), 'result.json'), 'utf8'));
        } catch {
            view.result = null;
        }
        return view;
    }

    pendingFor(owner) {
        const out = [];
        for (const job of this.jobs.values()) {
            if (job.owner !== owner) continue;
            if (TERMINAL_STATES.includes(job.state) && job.claimedAt) continue;
            out.push(this.publicView(job));
        }
        return out.sort((a, b) => a.createdAt - b.createdAt);
    }

    waitForChange(id, ms) {
        return new Promise(resolve => {
            const set = this.waiters.get(id) ?? new Set();
            set.add(resolve);
            this.waiters.set(id, set);
            const timer = setTimeout(() => { set.delete(resolve); resolve(); }, ms);
            timer.unref?.();
        });
    }

    #emit(id) {
        const set = this.waiters.get(id);
        if (!set) return;
        for (const resolve of set) resolve();
        this.waiters.delete(id);
    }

    #persist(job) {
        const file = path.join(this.#jobPath(job.owner, job.id), 'job.json');
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
        fs.renameSync(tmp, file);
    }

    #prune() {
        const cutoff = Date.now() - RETENTION_MS;
        for (const job of [...this.jobs.values()]) {
            if (!TERMINAL_STATES.includes(job.state)) continue;
            if ((job.finishedAt ?? job.createdAt) >= cutoff) continue;
            fs.rmSync(this.#jobPath(job.owner, job.id), { recursive: true, force: true });
            this.jobs.delete(job.id);
        }
    }
}
