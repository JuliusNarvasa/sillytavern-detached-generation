/*
 * Detached Generation — client-side companion for the `detached` server plugin.
 *
 * When enabled, fetch() calls to any /api/backends/<backend>/generate are redirected to
 * the plugin's submit endpoint. The plugin re-issues the request to ST's own backend over
 * localhost on a socket the plugin owns, so closing the browser cannot abort generation.
 * The client receives a synthetic SSE Response replaying the recorded stream, so the
 * entire stock streaming pipeline (StreamingProcessor / saveReply / swipes) runs unmodified
 * while the tab is alive. If the tab dies mid-stream, a later session picks the finished
 * result up via /pending + /claim and inserts it as a normal message.
 *
 * With the toggle OFF this extension is a pass-through: byte-identical stock behavior.
 */
import { extension_settings } from '../../../extensions.js';
import {
    chat,
    characters,
    this_chid,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    saveReply,
    saveChatConditional,
    saveSettingsDebounced,
    Generate,
} from '../../../../script.js';
// Namespace import for optional APIs: setOnlineStatus is only exported from
// SillyTavern 1.13.0. On older versions the reattach still works, but the
// "backend disconnected" guard of Generate() cannot be bypassed.
import * as scriptModule from '../../../../script.js';

const setOnlineStatus = scriptModule.setOnlineStatus ?? ((value) => {
    console.warn('[DetachedGen] setOnlineStatus is unavailable in this SillyTavern version.');
});

const PLUGIN_BASE = '/api/plugins/detached';
const GENERATE_RE = /^\/api\/backends\/[a-z-]+\/generate$/;
const TERMINAL = ['done', 'error', 'cancelled', 'interrupted'];

const settings = (extension_settings.detachedGen ??= { enabled: false });

const rawFetch = window.fetch.bind(window);
const activeJobs = new Set();
/** When set, the next generate request replays this existing job instead of submitting
 *  a new one. Used to re-enter ST's native streaming flow for a job that is still
 *  running on the server (so the reply streams live into the chat). */
let reattachTarget = null;

function loadConsumed() {
    try { return JSON.parse(localStorage.getItem('detachedGen:consumed') ?? '[]'); }
    catch { return []; }
}
const consumed = new Set(loadConsumed());
function persistConsumed() {
    try { localStorage.setItem('detachedGen:consumed', JSON.stringify([...consumed].slice(-200))); }
    catch { /* private mode etc. */ }
}

function safePathname(url) {
    try { return new URL(url, location.origin).pathname; }
    catch { return ''; }
}

// ── 1. The interception: single patch covers every backend ──
window.fetch = async function (input, init) {
    let url = '';
    try {
        url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    } catch { /* let fetch deal with it */ }
    const isGenerate = init?.method === 'POST' && GENERATE_RE.test(safePathname(url));
    if (!settings.enabled || !isGenerate) {
        return rawFetch(input, init);
    }
    // Reattach: replay an existing running job through ST's native streaming pipeline.
    if (reattachTarget) {
        const jobId = reattachTarget;
        reattachTarget = null;
        activeJobs.add(jobId);
        return restream(jobId);
    }
    try {
        return await detachedGenerate(url, init);
    } catch (err) {
        console.error('[DetachedGen] submit failed, falling back to direct generation', err);
        toastr?.error(String(err?.message ?? err), 'Detached Generation — falling back');
        return rawFetch(input, init);
    }
};

async function detachedGenerate(url, init) {
    const backend = safePathname(url).split('/')[3];
    const jobId = await submitJob(backend, init.body);
    activeJobs.add(jobId);
    toastr.info('Generation detached — safe to close this tab.', 'Detached Generation', { timeOut: 8000 });
    return restream(jobId);
}

async function submitJob(backend, rawBody) {
    const res = await rawFetch(`${PLUGIN_BASE}/submit`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend,
            generate_data: JSON.parse(rawBody),
            chat: {
                chatId: getCurrentChatId(),
                avatar_url: characters[this_chid]?.avatar ?? null,
                name: characters[this_chid]?.name ?? null,
            },
        }),
    });
    if (!res.ok) throw new Error(`submit ${res.status}: ${await res.text()}`);
    return (await res.json()).jobId;
}

// ── 2. Synthetic Response: replay plugin-recorded bytes as a normal SSE body ──
function restream(jobId) {
    const stream = new ReadableStream({
        async start(controller) {
            let completed = false;
            try {
                let since = 0;
                while (true) {
                    const res = await rawFetch(`${PLUGIN_BASE}/stream?jobId=${encodeURIComponent(jobId)}&since=${since}`, { headers: getRequestHeaders() });
                    if (!res.ok) throw new Error(`stream ${res.status}`);
                    const reader = res.body.getReader();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        since += value.byteLength;
                        controller.enqueue(value);
                    }
                    const status = await jobStatus(jobId);
                    if (!TERMINAL.includes(status.state)) continue;
                    if (status.state === 'error') {
                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: status.error ?? 'Detached generation failed' } })}\n\n`));
                    }
                    completed = true;
                    break;
                }
                controller.close();
            } catch (err) {
                controller.error(err);
            } finally {
                activeJobs.delete(jobId);
                // Only a job that actually finished may be marked as consumed. If this
                // page went away mid-stream (refresh, tab close, navigation) the job is
                // still running on the server and must stay claimable for reattach.
                if (completed) {
                    consumed.add(jobId);
                    persistConsumed();
                }
            }
        },
        // NOTE: deliberately no cancel() handler. This fires when the consumer stops
        // reading - which happens on refresh/tab close/navigation, i.e. exactly the
        // situation where the server-side generation MUST keep running. Explicit
        // cancellation happens only via the Stop button (GENERATION_STOPPED).
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
}

async function jobStatus(jobId) {
    const res = await rawFetch(`${PLUGIN_BASE}/status?jobId=${encodeURIComponent(jobId)}`, { headers: getRequestHeaders() });
    return res.ok ? res.json() : { state: 'error', error: `status ${res.status}` };
}

// ── 3. Reattach: pick up jobs that finished while the browser was closed ──
async function reattach() {
    if (!settings.enabled) return;
    let jobs;
    try {
        const res = await rawFetch(`${PLUGIN_BASE}/pending`, { headers: getRequestHeaders() });
        if (!res.ok) return;
        ({ jobs } = await res.json());
    } catch { return; }

    const chatId = getCurrentChatId();
    const avatar = characters[this_chid]?.avatar ?? null;

    for (const job of jobs) {
        if (consumed.has(job.id)) continue;
        // only auto-claim jobs belonging to the currently open chat
        if (job.chat?.chatId && job.chat.chatId !== chatId) continue;
        if (avatar && job.chat?.avatar_url && job.chat.avatar_url !== avatar) continue;
        await reattachJob(job.id);
    }
}

async function reattachJob(jobId) {
    // Single-flight: APP_READY and CHAT_CHANGED can both fire for the same job.
    // Without this guard a second attempt would submit a brand new generation.
    if (reattaching.has(jobId)) return;
    reattaching.add(jobId);
    try {
        await reattachJobInner(jobId);
    } finally {
        reattaching.delete(jobId);
    }
}

async function reattachJobInner(jobId) {
    let status;
    try {
        const res = await rawFetch(`${PLUGIN_BASE}/status?jobId=${encodeURIComponent(jobId)}`, { headers: getRequestHeaders() });
        if (!res.ok) return;
        status = await res.json();
    } catch { return; }

    // Still generating on the server: re-enter ST's own generation flow so the reply
    // streams live into the chat (same UI as a normal generation).
    if (status.state === 'queued' || status.state === 'running') {
        toastr.info('Reattaching to a generation that is still running on the server…', 'Detached Generation');
        reattachTarget = jobId;
        try {
            // automatic_trigger: true => ST does not send the textarea as a user message
            // (script.js:4448), so the already-sent prompt is not duplicated.
            // ST refuses to generate when the backend is marked disconnected
            // (script.js:4391). A reattach never touches the backend directly - the
            // recorded job is replayed from disk - so that guard is bypassed here.
            const previousStatus = window.SillyTavern.getContext().onlineStatus;
            setOnlineStatus('Valid');
            console.log('[DetachedGen] reattach: replaying job', jobId);
            const result = await Generate('normal', { automatic_trigger: true });
            console.log('[DetachedGen] reattach: Generate returned', typeof result, String(result).slice(0, 60));
            setOnlineStatus(previousStatus);
        } catch (err) {
            console.error('[DetachedGen] reattach stream failed', err);
            reattachTarget = null;
            scheduleReattach(jobId);
            return;
        }
        // The job was streamed into the chat by ST's normal save path -> mark it claimed.
        await claimJob(jobId);
        consumed.add(jobId);
        persistConsumed();
        return;
    }

    let result;
    try {
        const res = await rawFetch(`${PLUGIN_BASE}/claim`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ jobId }),
        });
        if (!res.ok) return;
        result = await res.json();
    } catch { return; }

    if (result.claimed) {
        // Another client already picked this result up.
        return;
    }
    consumed.add(jobId);
    persistConsumed();

    if (!result.result?.text) {
        if (result.state !== 'done') {
            toastr.warning(`Detached generation ${result.state}: ${result.error ?? 'no output'}`, 'Detached Generation');
        }
        return;
    }
    await insertResult(result.result);
}

/** Marks a job as claimed server-side so it is not offered again by /pending. */
async function claimJob(jobId) {
    try {
        await rawFetch(`${PLUGIN_BASE}/claim`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ jobId }),
        });
    } catch { /* best effort */ }
}

/**
 * Checks that the server-side plugin is installed and loaded.
 * The plugin answers with JSON (`{ error: 'No such job' }`) when the route exists;
 * a missing route produces ST's generic 404, so the response shape tells us apart.
 */
async function checkServerPlugin() {
    try {
        const res = await rawFetch(`${PLUGIN_BASE}/status?jobId=__healthcheck__`, { headers: getRequestHeaders() });
        const contentType = res.headers.get('content-type') || '';
        if (res.ok || (res.status === 404 && contentType.includes('json'))) {
            return { ok: true };
        }
        return { ok: false, reason: `HTTP ${res.status}` };
    } catch (err) {
        return { ok: false, reason: String(err?.message ?? err) };
    }
}

function showServerPluginWarning(reason) {
    if (document.getElementById('detached_gen_server_warning')) return;
    const html = `
    <div id="detached_gen_server_warning" class="st-perf-settings">
        <b>Detached Generation: the server plugin is not installed.</b><br>
        Generation will keep running in the browser only (closing the tab stops it).<br>
        Install the server part from the same repository:
        <pre>cd &lt;sillytavern-directory&gt;
cp -r server-plugin plugins/detached
# set enableServerPlugins: true in config.yaml, then restart the server</pre>
        <small class="opacity70p">Reason: ${reason}</small>
    </div>`;
    const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    target?.insertAdjacentHTML('beforeend', html);
}

async function verifyServerPlugin() {
    const health = await checkServerPlugin();
    if (!health.ok) {
        showServerPluginWarning(health.reason);
        console.warn('[DetachedGen] server plugin not available:', health.reason);
    }
    return health;
}

/** Polls a still-running job until it reaches a terminal state, then inserts its result.
 *  Without this, a job that was still running when the page loaded would never be
 *  picked up (the reattach pass only runs on APP_READY / CHAT_CHANGED). */
const reattachTimers = new Set();
/** Job IDs currently being reattached (single-flight guard). */
const reattaching = new Set();
function scheduleReattach(jobId, attempt = 0) {
    if (reattachTimers.has(jobId)) return;
    if (attempt > 240) {  // ~20 minutes
        reattachTimers.delete(jobId);
        return;
    }
    const timer = setTimeout(async () => {
        reattachTimers.delete(jobId);
        if (consumed.has(jobId)) return;
        let status;
        try {
            const res = await rawFetch(`${PLUGIN_BASE}/status?jobId=${encodeURIComponent(jobId)}`, { headers: getRequestHeaders() });
            if (!res.ok) return;
            status = await res.json();
        } catch { return; }
        if (status.state === 'queued' || status.state === 'running') {
            scheduleReattach(jobId, attempt + 1);
            return;
        }
        await reattachJob(jobId);
    }, 5000);
    reattachTimers.add(jobId);
}

async function insertResult(result) {
    const last = chat[chat.length - 1];
    if (last && !last.is_user && last.mes === result.text) return;
    await saveReply({ type: 'normal', getMessage: result.text, fromStreaming: false, title: '', swipes: [], reasoning: result.reasoning ?? '' });
    await saveChatConditional();
    toastr.success('Detached generation completed and inserted.', 'Detached Generation');
}

eventSource.on(event_types.APP_READY, reattach);
eventSource.on(event_types.CHAT_CHANGED, reattach);

// Warn (once) when the server-side plugin is missing, so the feature is self-diagnosing.
eventSource.on(event_types.APP_READY, verifyServerPlugin);

// Extensions may be activated after APP_READY was emitted - in that case the handler
// above never fires, so run the reattach pass immediately when the app is already ready.
if (typeof eventSource.isReady === 'function' && eventSource.isReady()) {
    reattach();
    verifyServerPlugin();
}

// Debug/testing handle.
window.__detachedGen = { reattach, reattachJob, scheduleReattach, verifyServerPlugin, checkServerPlugin, settings, get jobs() { return activeJobs; } };

// Stop button: the client aborted its stream reader -> cancel the server job
eventSource.on(event_types.GENERATION_STOPPED, () => {
    for (const jobId of [...activeJobs]) {
        rawFetch(`${PLUGIN_BASE}/cancel`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ jobId }),
        }).catch(() => { });
    }
});

// ── 4. Settings UI ──
function addSettingsUI() {
    const html = `
    <div class="detached-gen-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Detached Generation</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="detached_gen_enabled">
                    <input id="detached_gen_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                    <span>Detached mode (generation survives closing the tab)</span>
                </label>
                <small class="opacity70p">While enabled, new generations run on the server. You can close the tab after sending and read the reply later. Stop cancels the server-side job.</small>
            </div>
        </div>
    </div>`;
    const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', html);
    document.getElementById('detached_gen_enabled')?.addEventListener('change', (event) => {
        settings.enabled = Boolean(event.target.checked);
        saveSettingsDebounced();
    });
}

addSettingsUI();
