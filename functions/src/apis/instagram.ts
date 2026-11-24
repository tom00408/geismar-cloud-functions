import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage, getDownloadURL } from 'firebase-admin/storage';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

if (!getApps().length) {
	initializeApp();
}

// --- Automatisches Posten auf Instagram ---
// Weg: „Instagram API with Unified Login“ — für neue Meta-Apps der einzige.
// Login läuft über Facebook Login for Business mit einer Konfiguration
// (config_id). Ergebnis ist ein System-User-Token des Business-Portfolios
// „MTV Geismar“, der laut Konfiguration nicht abläuft und für ALLE dem
// Login freigegebenen Instagram-Accounts gilt. Accounts werden über den
// Handle den socialMediaAccounts zugeordnet; der Token liegt je Account in
// instagramVerbindungen/{accountId} (Rules: kein Client-Zugriff).
// Fällige Posts mit autoPost veröffentlicht instagramPoster alle 5 Minuten.

const META_APP_ID = defineSecret('META_APP_ID');
const META_APP_SECRET = defineSecret('META_APP_SECRET');
const META_LOGIN_CONFIG_ID = defineSecret('META_LOGIN_CONFIG_ID');
const SECRETS = [META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID];

const REGION = 'europe-west3';
const REDIRECT_URI = `https://${REGION}-mtvgeismar-3bf45.cloudfunctions.net/instagramOauthCallback`;
const AUTHORIZE_URL = 'https://www.facebook.com/dialog/oauth';
const GRAPH = 'https://graph.facebook.com/v27.0';

const MAX_VERSUCHE = 3;
const MAX_BILDER = 10;

const db = () => getFirestore();
const verbindungDoc = (accountId: string) => db().doc(`instagramVerbindungen/${accountId}`);
const stateDoc = (state: string) => db().doc(`instagramVerbindungen/oauth-${state}`);

const DASHBOARD_ADMINS = ['handball@mtvgeismar.de', 'geschaeftsstelle@mtvgeismar.de'];

// trim: interaktiv gesetzte Secrets enthalten gern einen Zeilenumbruch
const appId = () => META_APP_ID.value().trim();
const appSecret = () => META_APP_SECRET.value().trim();
const configId = () => META_LOGIN_CONFIG_ID.value().trim();

const handleNorm = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

// Admin oder Social-Modul mit allen Teams — dieselbe „Leitung“ wie in firestore.rules
async function assertLeitung(uid: string | undefined, email: string | undefined) {
	if (!uid) throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	const dash = await db().doc(`dashboardUsers/${uid}`).get();
	if (dash.get('rolle') === 'admin') return;
	const module = (dash.get('module') as string[] | undefined) ?? [];
	if (module.includes('social') && dash.get('alleTeams') !== false) return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung.');
}

// Darf dieser Nutzer Posts dieses Teams auslösen?
async function assertTeamZugriff(uid: string | undefined, email: string | undefined, teamId: string) {
	if (!uid) throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	const dash = await db().doc(`dashboardUsers/${uid}`).get();
	if (dash.get('rolle') === 'admin') return;
	const module = (dash.get('module') as string[] | undefined) ?? [];
	const teams = (dash.get('teams') as string[] | undefined) ?? [];
	if (module.includes('social') && (dash.get('alleTeams') !== false || teams.includes(teamId))) return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung für diese Mannschaft.');
}

// --- Graph-API-Helfer ---

async function graph(pfad: string, params: Record<string, string>, methode: 'GET' | 'POST' = 'GET'): Promise<any> {
	const url = new URL(`${GRAPH}${pfad}`);
	let body: URLSearchParams | undefined;
	if (methode === 'GET') {
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	} else {
		body = new URLSearchParams(params);
	}
	const res = await fetch(url, { method: methode, body });
	const json = (await res.json().catch(() => ({}))) as any;
	if (!res.ok || json.error) {
		const msg = json.error?.error_user_msg || json.error?.message || `HTTP ${res.status}`;
		throw new Error(`Instagram: ${msg}`);
	}
	return json;
}

// --- Verbinden ---

export const instagramAuthUrl = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
	await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);
	const accountId = (request.data as { accountId?: string })?.accountId;
	if (!accountId) throw new HttpsError('invalid-argument', 'accountId fehlt.');
	const account = await db().doc(`socialMediaAccounts/${accountId}`).get();
	if (!account.exists) throw new HttpsError('not-found', 'Account nicht gefunden.');

	const state = randomBytes(16).toString('hex');
	await stateDoc(state).set({
		accountId,
		uid: request.auth?.uid,
		createdAt: FieldValue.serverTimestamp(),
	});

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('client_id', appId());
	url.searchParams.set('config_id', configId());
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('override_default_response_type', 'true');
	url.searchParams.set('display', 'popup');
	url.searchParams.set('state', state);
	// Zeigt Facebook- und Instagram-Anmeldung zur Auswahl
	url.searchParams.set('prompt', 'login');
	return { url: url.toString() };
});

export const instagramOauthCallback = onRequest({ region: REGION, secrets: SECRETS }, async (req, res) => {
	const { code, state, error, error_description } = req.query as Record<string, string>;
	const fertig = (titel: string, text = 'Du kannst dieses Fenster schließen.') => {
		res.status(200).send(
			`<!doctype html><html lang="de"><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:80px 20px 0">
			<h2>${titel}</h2><p>${text}</p></body></html>`
		);
	};

	if (error) {
		fertig('Instagram-Verbindung abgebrochen.', error_description || error);
		return;
	}
	if (!code || !state) {
		res.status(400).send('code/state fehlt.');
		return;
	}
	const stateSnap = await stateDoc(state).get();
	if (!stateSnap.exists) {
		res.status(400).send('Ungültiger oder abgelaufener Link.');
		return;
	}
	const gewuenschterAccount = stateSnap.get('accountId') as string;
	const verbundenVon = stateSnap.get('uid') as string;
	await stateDoc(state).delete();

	try {
		// 1. Code gegen System-User-Token des Business-Portfolios tauschen
		const tokenRes = await graph('/oauth/access_token', {
			client_id: appId(),
			client_secret: appSecret(),
			redirect_uri: REDIRECT_URI,
			code,
		});
		const token = tokenRes.access_token as string;
		const laeuftAb = tokenRes.expires_in
			? Timestamp.fromMillis(Date.now() + Number(tokenRes.expires_in) * 1000)
			: null;

		// 2. Welche Instagram-Accounts hat der Login freigegeben?
		const freigegeben = (
			await graph('/me/assigned_instagram_accounts', { fields: 'id,username', access_token: token })
		).data as { id: string; username: string }[];
		if (!freigegeben?.length) {
			throw new Error('Beim Login wurde kein Instagram-Account freigegeben.');
		}

		// 3. Freigegebene Accounts den Dashboard-Accounts über den Handle zuordnen
		const accounts = await db().collection('socialMediaAccounts').get();
		const zugeordnet: string[] = [];
		for (const acc of accounts.docs) {
			const treffer = freigegeben.find((ig) => handleNorm(ig.username) === handleNorm(acc.get('handle') ?? ''));
			if (!treffer) continue;
			await verbindungDoc(acc.id).set({
				igUserId: treffer.id,
				username: treffer.username,
				token,
				laeuftAb,
				verbundenVon,
				verbundenAm: FieldValue.serverTimestamp(),
			});
			await acc.ref.set(
				{
					instagramVerbunden: true,
					instagramUsername: treffer.username,
					instagramLaeuftAb: laeuftAb ?? FieldValue.delete(),
					instagramFehler: FieldValue.delete(),
				},
				{ merge: true }
			);
			zugeordnet.push(`@${treffer.username}`);
		}

		const gewuenscht = accounts.docs.find((d) => d.id === gewuenschterAccount);
		const nichtZugeordnet = freigegeben
			.filter((ig) => !accounts.docs.some((d) => handleNorm(d.get('handle') ?? '') === handleNorm(ig.username)))
			.map((ig) => `@${ig.username}`);

		if (!zugeordnet.length) {
			fertig(
				'Kein passender Account gefunden.',
				`Freigegeben wurde ${nichtZugeordnet.join(', ')}, im Dashboard ist aber ${gewuenscht?.get('handle') ?? 'ein anderer Handle'} eingetragen. Handle im Dashboard anpassen und erneut verbinden.`
			);
			return;
		}
		const extra = nichtZugeordnet.length
			? ` Ohne Gegenstück im Dashboard: ${nichtZugeordnet.join(', ')} — dort als Account anlegen und erneut verbinden.`
			: '';
		fertig('Instagram verbunden ✓', `Verbunden: ${zugeordnet.join(', ')}.${extra} Du kannst dieses Fenster schließen.`);
	} catch (err) {
		console.error('Instagram-Verbindung fehlgeschlagen', err);
		fertig('Instagram-Verbindung fehlgeschlagen.', String((err as Error).message ?? err));
	}
});

export const instagramTrennen = onCall({ region: REGION }, async (request) => {
	await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);
	const accountId = (request.data as { accountId?: string })?.accountId;
	if (!accountId) throw new HttpsError('invalid-argument', 'accountId fehlt.');
	await verbindungDoc(accountId).delete();
	await db().doc(`socialMediaAccounts/${accountId}`).set(
		{
			instagramVerbunden: false,
			instagramUsername: FieldValue.delete(),
			instagramLaeuftAb: FieldValue.delete(),
		},
		{ merge: true }
	);
	return { ok: true };
});

// --- Veröffentlichen ---

// Instagram nimmt nur JPEG zwischen 4:5 (hoch) und 1.91:1 (quer). Alles
// andere wird mittig zugeschnitten und als JPEG im Storage abgelegt.
async function alsInstagramJpeg(postId: string, index: number, quelle: string): Promise<string> {
	const res = await fetch(quelle);
	if (!res.ok) throw new Error(`Bild ${index + 1} nicht ladbar (${res.status}).`);
	const eingabe = Buffer.from(await res.arrayBuffer());

	const bild = sharp(eingabe, { failOn: 'none' }).rotate();
	const meta = await bild.metadata();
	let breite = meta.autoOrient?.width ?? meta.width ?? 1080;
	let hoehe = meta.autoOrient?.height ?? meta.height ?? 1080;
	const verhaeltnis = breite / hoehe;
	if (verhaeltnis < 4 / 5) hoehe = Math.round(breite * (5 / 4));
	else if (verhaeltnis > 1.91) breite = Math.round(hoehe * 1.91);

	// sharp kennt pro Pipeline nur einen resize — Zuschnitt und Verkleinern
	// auf höchstens 1440 px Breite deshalb in einem Schritt
	const faktor = Math.min(1, 1440 / breite);
	const jpeg = await bild
		.resize({
			width: Math.round(breite * faktor),
			height: Math.round(hoehe * faktor),
			fit: 'cover',
			position: 'centre',
		})
		.flatten({ background: '#ffffff' })
		.jpeg({ quality: 90, mozjpeg: true })
		.toBuffer();

	const datei = getStorage().bucket().file(`instagram-export/${postId}/${index}.jpg`);
	await datei.save(jpeg, { contentType: 'image/jpeg', resumable: false });
	return getDownloadURL(datei);
}

async function warteBisFertig(containerId: string, token: string) {
	for (let i = 0; i < 20; i++) {
		const s = await graph(`/${containerId}`, { fields: 'status_code,status', access_token: token });
		if (s.status_code === 'FINISHED') return;
		if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
			throw new Error(`Instagram konnte das Bild nicht verarbeiten (${s.status ?? s.status_code}).`);
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw new Error('Instagram hat das Bild nicht rechtzeitig verarbeitet.');
}

async function veroeffentlichen(postId: string): Promise<{ id: string; permalink: string }> {
	const postRef = db().doc(`socialMediaPosts/${postId}`);
	const post = (await postRef.get()).data();
	if (!post) throw new Error('Post nicht gefunden.');

	const verbindung = (await verbindungDoc(post.accountId).get()).data();
	if (!verbindung) throw new Error('Der Instagram-Account dieses Posts ist nicht verbunden.');
	const { igUserId, token } = verbindung as { igUserId: string; token: string };

	const quellen = ((post.imageUrls as string[] | undefined) ?? []).slice(0, MAX_BILDER);
	if (!quellen.length) throw new Error('Der Post hat kein Bild.');
	const caption = String(post.caption ?? '').slice(0, 2200);

	const bilder: string[] = [];
	for (const [i, q] of quellen.entries()) bilder.push(await alsInstagramJpeg(postId, i, q));

	let containerId: string;
	if (bilder.length === 1) {
		containerId = (await graph(`/${igUserId}/media`, { image_url: bilder[0]!, caption, access_token: token }, 'POST')).id;
	} else {
		const kinder: string[] = [];
		for (const url of bilder) {
			const kind = await graph(
				`/${igUserId}/media`,
				{ image_url: url, is_carousel_item: 'true', access_token: token },
				'POST'
			);
			await warteBisFertig(kind.id, token);
			kinder.push(kind.id);
		}
		containerId = (
			await graph(
				`/${igUserId}/media`,
				{ media_type: 'CAROUSEL', children: kinder.join(','), caption, access_token: token },
				'POST'
			)
		).id;
	}
	await warteBisFertig(containerId, token);

	const veroeffentlicht = await graph(
		`/${igUserId}/media_publish`,
		{ creation_id: containerId, access_token: token },
		'POST'
	);
	const details = await graph(`/${veroeffentlicht.id}`, { fields: 'permalink', access_token: token }).catch(
		() => ({}) as any
	);
	return { id: veroeffentlicht.id, permalink: details.permalink ?? '' };
}

// Sperrt den Post per Transaktion, damit Zeitplan und „Jetzt posten“
// nie doppelt veröffentlichen. Gibt false zurück, wenn schon in Arbeit.
// Eine Sperre, die älter als 15 Minuten ist, gilt als abgestürzt.
const SPERRE_MS = 15 * 60 * 1000;
async function sperren(postId: string): Promise<boolean> {
	const ref = db().doc(`socialMediaPosts/${postId}`);
	return db().runTransaction(async (tx) => {
		const snap = await tx.get(ref);
		const zustand = snap.get('postingStatus');
		const gestartet = (snap.get('postingGestartet') as Timestamp | undefined)?.toMillis() ?? 0;
		const laeuftNoch = zustand === 'laeuft' && Date.now() - gestartet < SPERRE_MS;
		if (!snap.exists || laeuftNoch || snap.get('status') === 'gepostet') return false;
		tx.update(ref, {
			postingStatus: 'laeuft',
			postingVersuche: FieldValue.increment(1),
			postingGestartet: FieldValue.serverTimestamp(),
		});
		return true;
	});
}

async function postBearbeiten(postId: string): Promise<{ ok: boolean; fehler?: string; permalink?: string }> {
	if (!(await sperren(postId))) return { ok: false, fehler: 'Wird schon gepostet.' };
	const ref = db().doc(`socialMediaPosts/${postId}`);
	try {
		const ergebnis = await veroeffentlichen(postId);
		await ref.update({
			status: 'gepostet',
			postingStatus: 'fertig',
			postingFehler: FieldValue.delete(),
			instagramMediaId: ergebnis.id,
			instagramPermalink: ergebnis.permalink,
			gepostetAm: FieldValue.serverTimestamp(),
			updatedAt: FieldValue.serverTimestamp(),
		});
		return { ok: true, permalink: ergebnis.permalink };
	} catch (err) {
		const fehler = String((err as Error).message ?? err);
		console.error('Instagram-Post fehlgeschlagen', postId, fehler);
		const versuche = Number((await ref.get()).get('postingVersuche') ?? 1);
		await ref.update({
			postingStatus: versuche >= MAX_VERSUCHE ? 'fehler' : 'wartet',
			postingFehler: fehler,
			updatedAt: FieldValue.serverTimestamp(),
		});
		return { ok: false, fehler };
	}
}

// Fällige Posts: Status „geplant“, autoPost an, Zeitpunkt erreicht
export const instagramPoster = onSchedule(
	{ region: REGION, schedule: 'every 5 minutes', timeZone: 'Europe/Berlin', secrets: SECRETS, timeoutSeconds: 540, memory: '1GiB' },
	async () => {
		const faellig = await db()
			.collection('socialMediaPosts')
			.where('autoPost', '==', true)
			.where('status', '==', 'geplant')
			.where('scheduledAt', '<=', Timestamp.now())
			.limit(20)
			.get();
		for (const d of faellig.docs) {
			const zustand = d.get('postingStatus');
			if (zustand === 'fehler' || zustand === 'fertig') continue;
			await postBearbeiten(d.id);
		}
	}
);

// Sofort posten aus dem Post-Fenster
export const instagramJetztPosten = onCall(
	{ region: REGION, secrets: SECRETS, timeoutSeconds: 300, memory: '1GiB' },
	async (request) => {
		const postId = (request.data as { postId?: string })?.postId;
		if (!postId) throw new HttpsError('invalid-argument', 'postId fehlt.');
		const post = await db().doc(`socialMediaPosts/${postId}`).get();
		if (!post.exists) throw new HttpsError('not-found', 'Post nicht gefunden.');
		await assertTeamZugriff(request.auth?.uid, request.auth?.token.email ?? undefined, post.get('teamId'));
		// Nach Fehlern erneut erlauben
		if (post.get('postingStatus') === 'fehler') {
			await post.ref.update({ postingStatus: 'wartet', postingVersuche: 0 });
		}
		return postBearbeiten(postId);
	}
);
