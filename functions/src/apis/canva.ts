import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage, getDownloadURL } from 'firebase-admin/storage';
import { randomBytes, createHash } from 'node:crypto';

if (!getApps().length) {
	initializeApp();
}

const CANVA_CLIENT_ID = defineSecret('CANVA_CLIENT_ID');
const CANVA_CLIENT_SECRET = defineSecret('CANVA_CLIENT_SECRET');

const REGION = 'europe-west3';
const REDIRECT_URI = `https://${REGION}-mtvgeismar-3bf45.cloudfunctions.net/canvaOauthCallback`;
const AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const API_BASE = 'https://api.canva.com/rest/v1';
const SCOPES = 'design:meta:read design:content:read';

// Eine gemeinsame Vereins-Verbindung (ein Canva-Konto für alle)
const connectionDoc = () => getFirestore().doc('socialMediaCanva/connection');
const stateDoc = (state: string) => getFirestore().doc(`socialMediaCanva/oauth-${state}`);

const DASHBOARD_ADMINS = ['handball@mtvgeismar.de', 'geschaeftsstelle@mtvgeismar.de'];

async function assertLeitung(uid: string | undefined, email: string | undefined) {
	if (!uid) throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	// Dashboard-Konto mit Admin-Rolle oder freigeschaltetem Social-Modul
	// (siehe dashboardUsers / firestore.rules hatModul('social')).
	const dash = await getFirestore().doc(`dashboardUsers/${uid}`).get();
	if (dash.get('rolle') === 'admin') return;
	if (((dash.get('module') as string[] | undefined) ?? []).includes('social')) return;
	const profile = await getFirestore().doc(`socialMediaUsers/${uid}`).get();
	const role = profile.get('role');
	if (role === 'admin' || role === 'vorstand') return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung.');
}

function basicAuth(): string {
	// trim: interaktiv gesetzte Secrets enthalten gern einen Zeilenumbruch
	return Buffer.from(`${CANVA_CLIENT_ID.value().trim()}:${CANVA_CLIENT_SECRET.value().trim()}`).toString(
		'base64'
	);
}

interface TokenSet {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${basicAuth()}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	});
	if (!res.ok) {
		throw new Error(`Canva-Token-Fehler ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as TokenSet;
}

async function saveTokens(tokens: TokenSet) {
	await connectionDoc().set({
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + tokens.expires_in * 1000,
		updatedAt: FieldValue.serverTimestamp(),
	});
}

// Gültigen Access-Token holen, bei Bedarf per Refresh-Token erneuern
async function getAccessToken(): Promise<string> {
	const snap = await connectionDoc().get();
	if (!snap.exists) {
		throw new HttpsError('failed-precondition', 'Canva ist noch nicht verbunden.');
	}
	const data = snap.data() as { accessToken: string; refreshToken: string; expiresAt: number };
	if (Date.now() < data.expiresAt - 60_000) return data.accessToken;

	const tokens = await tokenRequest(
		new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refreshToken })
	);
	await saveTokens(tokens);
	return tokens.access_token;
}

async function canvaGet(path: string): Promise<any> {
	const token = await getAccessToken();
	const res = await fetch(`${API_BASE}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`Canva-API ${res.status}: ${await res.text()}`);
	return res.json();
}

async function canvaPost(path: string, body: unknown): Promise<any> {
	const token = await getAccessToken();
	const res = await fetch(`${API_BASE}${path}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Canva-API ${res.status}: ${await res.text()}`);
	return res.json();
}

// Nur Dashboard-Admins (Verbindung wird im Accounts-Modul verwaltet)
async function assertAdmin(uid: string | undefined, email: string | undefined) {
	if (!uid) throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	const dash = await getFirestore().doc(`dashboardUsers/${uid}`).get();
	if (dash.get('rolle') === 'admin') return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung.');
}

// --- Verbindung trennen (nur Admin) ---
export const canvaDisconnect = onCall(
	{ region: REGION, secrets: [CANVA_CLIENT_ID, CANVA_CLIENT_SECRET] },
	async (request) => {
		await assertAdmin(request.auth?.uid, request.auth?.token.email ?? undefined);
		await connectionDoc().delete();
		return { ok: true };
	}
);

// --- Status: verbunden ja/nein ---
export const canvaStatus = onCall(
	{ region: REGION, secrets: [CANVA_CLIENT_ID, CANVA_CLIENT_SECRET] },
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);
		const snap = await connectionDoc().get();
		return { connected: snap.exists };
	}
);

// --- Schritt 1: Autorisierungs-URL bauen (PKCE) ---
export const canvaAuthUrl = onCall(
	{ region: REGION, secrets: [CANVA_CLIENT_ID, CANVA_CLIENT_SECRET] },
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);

		const state = randomBytes(16).toString('hex');
		const verifier = randomBytes(48).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');

		await stateDoc(state).set({ verifier, createdAt: FieldValue.serverTimestamp() });

		const url = new URL(AUTHORIZE_URL);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', CANVA_CLIENT_ID.value().trim());
		url.searchParams.set('redirect_uri', REDIRECT_URI);
		url.searchParams.set('scope', SCOPES);
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');
		return { url: url.toString() };
	}
);

// --- Schritt 2: OAuth-Callback (von Canva aufgerufen) ---
export const canvaOauthCallback = onRequest(
	{ region: REGION, secrets: [CANVA_CLIENT_ID, CANVA_CLIENT_SECRET] },
	async (req, res) => {
		const { code, state, error } = req.query as Record<string, string>;
		const finish = (msg: string) => {
			res.status(200).send(
				`<!doctype html><html lang="de"><body style="font-family:sans-serif;text-align:center;padding-top:80px">
				<h2>${msg}</h2><p>Du kannst dieses Fenster schließen.</p></body></html>`
			);
		};

		if (error) {
			finish(`Canva-Verbindung abgebrochen (${error}).`);
			return;
		}
		if (!code || !state) {
			res.status(400).send('code/state fehlt.');
			return;
		}

		const snap = await stateDoc(state).get();
		if (!snap.exists) {
			res.status(400).send('Ungültiger state.');
			return;
		}
		const verifier = snap.get('verifier') as string;
		await stateDoc(state).delete();

		try {
			const tokens = await tokenRequest(
				new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					redirect_uri: REDIRECT_URI,
					code_verifier: verifier,
				})
			);
			await saveTokens(tokens);
			finish('Canva verbunden ✓');
		} catch (err) {
			console.error(err);
			finish('Canva-Verbindung fehlgeschlagen.');
		}
	}
);

// --- Designs auflisten/suchen ---
export const canvaListDesigns = onCall(
	{ region: REGION, secrets: [CANVA_CLIENT_ID, CANVA_CLIENT_SECRET] },
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);
		const { query, continuation } = (request.data ?? {}) as {
			query?: string;
			continuation?: string;
		};
		const params = new URLSearchParams();
		if (query) params.set('query', query);
		if (continuation) params.set('continuation', continuation);
		params.set('limit', '30');

		try {
			const result = await canvaGet(`/designs?${params.toString()}`);
			const items = (result.items ?? []).map((d: any) => ({
				id: d.id,
				title: d.title ?? 'Ohne Titel',
				thumbnailUrl: d.thumbnail?.url ?? '',
				editUrl: d.urls?.edit_url ?? '',
			}));
			return { items, continuation: result.continuation ?? null };
		} catch (err) {
			console.error(err);
			throw new HttpsError('internal', 'Designs konnten nicht geladen werden.');
		}
	}
);

// PNG-Maße aus dem Header lesen (IHDR: Breite/Höhe bei Byte 16/20)
function pngDimensions(buf: Buffer): { width: number; height: number } {
	if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	return { width: 1080, height: 1350 };
}

// --- Design als PNG exportieren und in Storage ablegen ---
export const canvaImportDesign = onCall(
	{
		region: REGION,
		secrets: [CANVA_CLIENT_ID, CANVA_CLIENT_SECRET],
		timeoutSeconds: 300,
		memory: '512MiB',
	},
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);
		const designId = (request.data as { designId?: string })?.designId;
		if (!designId) throw new HttpsError('invalid-argument', 'designId fehlt.');

		try {
			const job = await canvaPost('/exports', {
				design_id: designId,
				format: { type: 'png' },
			});
			let jobData = job.job;
			const started = Date.now();
			while (jobData.status === 'in_progress') {
				if (Date.now() - started > 240_000) throw new Error('Export-Timeout.');
				await new Promise((r) => setTimeout(r, 2000));
				const poll = await canvaGet(`/exports/${jobData.id}`);
				jobData = poll.job;
			}
			if (jobData.status !== 'success' || !jobData.urls?.length) {
				throw new Error(`Export fehlgeschlagen: ${JSON.stringify(jobData.error ?? jobData)}`);
			}

			const download = await fetch(jobData.urls[0]);
			if (!download.ok) throw new Error(`Download ${download.status}`);
			const buf = Buffer.from(await download.arrayBuffer());
			const { width, height } = pngDimensions(buf);

			const bucket = getStorage().bucket();
			const file = bucket.file(`socialMedia/templates/canva-${designId}-${Date.now()}.png`);
			await file.save(buf, { contentType: 'image/png' });
			const backgroundUrl = await getDownloadURL(file);

			return { backgroundUrl, width, height };
		} catch (err) {
			console.error(err);
			throw new HttpsError('internal', 'Import fehlgeschlagen — Details im Functions-Log.');
		}
	}
);
