import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

if (!getApps().length) {
	initializeApp();
}

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

const MODEL = 'gpt-5-mini';

const DASHBOARD_ADMINS = ['handball@mtvgeismar.de', 'geschaeftsstelle@mtvgeismar.de'];

async function assertLeitung(uid: string | undefined, email: string | undefined) {
	if (!uid) throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	const dash = await getFirestore().doc(`dashboardUsers/${uid}`).get();
	if (dash.get('rolle') === 'admin') return;
	if (((dash.get('module') as string[] | undefined) ?? []).includes('social')) return;
	const profile = await getFirestore().doc(`socialMediaUsers/${uid}`).get();
	const role = profile.get('role');
	if (role === 'admin' || role === 'vorstand' || role === 'team') return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung.');
}

const LogoSchema = z.object({
	kandidaten: z
		.array(
			z.object({
				url: z.string().describe('Direkte Bild-URL (endet auf .png/.jpg/.svg/.webp o. ä.)'),
				quelle: z.string().describe('Woher das Bild stammt (z. B. Vereinsseite, Wikipedia)'),
			})
		)
		.describe('2 bis 5 Kandidaten, bester zuerst'),
});

const ERLAUBTE_TYPEN = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'];
const MAX_BYTES = 3 * 1024 * 1024;

// Nur öffentliche https-URLs laden — kein Zugriff auf interne Adressen.
function urlErlaubt(raw: string): boolean {
	try {
		const u = new URL(raw);
		if (u.protocol !== 'https:') return false;
		const h = u.hostname;
		if (!h.includes('.')) return false;
		if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.endsWith('.local') || h === 'localhost') return false;
		return true;
	} catch {
		return false;
	}
}

async function bildLaden(url: string): Promise<{ data: string; mediaType: string } | null> {
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			signal: AbortSignal.timeout(10_000),
			headers: { 'User-Agent': 'Mozilla/5.0 (MTV-Geismar Dashboard Logo-Suche)' },
		});
		if (!res.ok) return null;
		const typ = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
		if (!ERLAUBTE_TYPEN.includes(typ)) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (!buf.length || buf.length > MAX_BYTES) return null;
		return { data: buf.toString('base64'), mediaType: typ };
	} catch {
		return null;
	}
}

// Sucht per KI-Websuche Logo-Kandidaten für einen Verein und liefert die
// Bilder als base64 zurück (Client zeigt Vorschau, User wählt aus und
// speichert selbst nach Storage/Firestore).
export const findeVereinsLogos = onCall(
	{ region: 'europe-west3', secrets: [OPENAI_API_KEY], timeoutSeconds: 180, memory: '512MiB' },
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);

		const vereinName = (request.data as { vereinName?: string })?.vereinName?.trim();
		if (!vereinName) {
			throw new HttpsError('invalid-argument', 'Fehlendes Feld (vereinName).');
		}

		const client = new OpenAI({ apiKey: OPENAI_API_KEY.value().trim() });

		let urls: { url: string; quelle: string }[] = [];
		try {
			const response = await client.responses.parse({
				model: MODEL,
				tools: [{ type: 'web_search' }],
				input:
					`Finde das offizielle Vereinslogo des Sportvereins „${vereinName}" ` +
					`(Handball, Region Göttingen/Südniedersachsen, Deutschland). ` +
					`Suche auf der Vereins-Website, Wikipedia, handball.net oder Vereinsverzeichnissen. ` +
					`Gib 2–5 DIREKTE Bild-URLs zurück (die URL muss direkt eine Bilddatei liefern, ` +
					`kein HTML). Bester Kandidat zuerst. Keine Fotos, nur Logos/Wappen.`,
				text: { format: zodTextFormat(LogoSchema, 'logos') },
			});
			urls = response.output_parsed?.kandidaten ?? [];
			console.log(`Logo-Suche „${vereinName}": KI lieferte ${urls.length} URLs`);
		} catch (error) {
			console.error('Logo-Suche fehlgeschlagen', error);
			throw new HttpsError('internal', 'Logo-Suche fehlgeschlagen.');
		}

		const kandidaten: { url: string; quelle: string; data: string; mediaType: string }[] = [];
		for (const k of urls.slice(0, 5)) {
			if (!urlErlaubt(k.url)) {
				console.log(`Logo-Suche „${vereinName}": URL verworfen (nicht erlaubt): ${k.url}`);
				continue;
			}
			const bild = await bildLaden(k.url);
			if (bild) {
				kandidaten.push({ url: k.url, quelle: k.quelle, ...bild });
			} else {
				console.log(`Logo-Suche „${vereinName}": Download fehlgeschlagen: ${k.url}`);
			}
			if (kandidaten.length >= 4) break;
		}
		console.log(`Logo-Suche „${vereinName}": ${kandidaten.length} Bilder geladen`);

		return { kandidaten };
	}
);
